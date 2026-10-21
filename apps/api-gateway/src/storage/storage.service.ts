import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { BadRequestException, Inject, Injectable, PayloadTooLargeException } from "@nestjs/common";
import { Transform, pipeline, type Readable } from "node:stream";

import { APP_CONFIG, type AppConfig } from "../config/config.js";

export interface StoredObject {
  body: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
  /** Solo en respuestas parciales (Range): "bytes inicio-fin/total". */
  contentRange: string | undefined;
  etag: string | undefined;
}

/** Los ETag de S3 llegan entre comillas; el contrato los usa sin ellas. */
const cleanEtag = (etag: string | undefined): string | undefined => etag?.replace(/^"|"$/g, "");

const isMissing = (error: unknown): boolean => {
  const name = (error as { name?: string }).name;
  return name === "NoSuchKey" || name === "NotFound";
};

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  readonly bucket: string;
  private readonly maxUploadBytes: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.s3.bucket;
    this.maxUploadBytes = config.maxUploadBytes;
    this.client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
    });
  }

  /**
   * Sube un flujo a S3 sin guardarlo en disco ni en memoria (subida multiparte). Cuenta los bytes
   * y aborta con 413 al pasar el límite, borrando lo ya subido. Devuelve el tamaño real.
   */
  async putStream(key: string, body: Readable, contentType: string): Promise<{ sizeBytes: number }> {
    let sizeBytes = 0;
    const limit = this.maxUploadBytes;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > limit) {
          callback(new PayloadTooLargeException(`El archivo supera el máximo de ${limit} bytes.`));
          return;
        }
        callback(null, chunk);
      },
    });
    // pipeline (no pipe): si el cliente corta la conexión a mitad de la subida, `body` se cierra sin
    // terminar y pipeline destruye `counter` con ERR_STREAM_PREMATURE_CLOSE. Con pipe() el contador
    // se quedaba esperando para siempre y la subida multiparte a S3 nunca se resolvía.
    pipeline(body, counter, () => undefined);

    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: counter, ContentType: contentType },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false, // si falla, se descartan las partes ya subidas
    });
    try {
      await upload.done();
    } catch (error) {
      await upload.abort().catch(() => undefined);
      await this.delete(key).catch(() => undefined);
      // La librería envuelve los errores del flujo: si fue el límite, se devuelve el 413 original.
      if (counter.errored instanceof PayloadTooLargeException) throw counter.errored;
      // El cliente cortó la conexión a mitad de la subida: no es un fallo del servidor.
      if ((counter.errored as NodeJS.ErrnoException | null)?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        throw new BadRequestException("La subida se interrumpió antes de terminar.");
      }
      throw error;
    }
    return { sizeBytes };
  }

  /** `range` es el valor de la cabecera Range del cliente ("bytes=0-1023"); S3 lo valida. */
  async getStream(key: string, range?: string): Promise<StoredObject | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }));
      return {
        body: out.Body as Readable,
        contentType: out.ContentType,
        contentLength: out.ContentLength,
        contentRange: out.ContentRange,
        etag: cleanEtag(out.ETag),
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async head(key: string): Promise<{ etag: string; size: number; contentType: string | undefined } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { etag: cleanEtag(out.ETag) ?? "", size: out.ContentLength ?? 0, contentType: out.ContentType };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Lee un objeto pequeño entero (p. ej. segments.json). Rechaza los que pasan de `maxBytes` sin leerlos. */
  async getBuffer(key: string, maxBytes: number): Promise<{ body: Buffer; etag: string } | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if ((out.ContentLength ?? 0) > maxBytes) {
        (out.Body as Readable).destroy();
        throw new PayloadTooLargeException(`El objeto supera ${maxBytes} bytes.`);
      }
      return { body: Buffer.from(await out.Body!.transformToByteArray()), etag: cleanEtag(out.ETag) ?? "" };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Escribe un objeto pequeño y devuelve su ETag. */
  async putBuffer(key: string, body: Buffer, contentType: string): Promise<{ etag: string }> {
    const out = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return { etag: cleanEtag(out.ETag) ?? "" };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Comprobación de salud con el permiso mínimo que tiene la cuenta (ListBucket bajo jobs/). */
  async ping(): Promise<void> {
    await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: "jobs/", MaxKeys: 1 }));
  }
}
