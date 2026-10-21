import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { BadRequestException, HttpException, Inject, Injectable, PayloadTooLargeException, RequestTimeoutException } from "@nestjs/common";
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

/**
 * Memoria por subida ≈ (cola + 1) × parte = 15 MiB. 5 MiB es el mínimo que acepta S3; con el tope de 4 GiB son
 * ~820 partes, muy por debajo de las 10 000 permitidas. Subir estos valores multiplica la RAM de cada subida.
 */
export const UPLOAD_QUEUE_SIZE = 2;
export const UPLOAD_PART_BYTES = 5 * 1024 * 1024;

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
  private readonly minBytesPerSecond: number;
  private readonly paceWindowMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.bucket = config.s3.bucket;
    this.maxUploadBytes = config.maxUploadBytes;
    this.minBytesPerSecond = config.security.uploadMinBytesPerSecond;
    this.paceWindowMs = config.security.uploadRateWindowMs;
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

    // Anti-goteo: un cliente que manda 1 byte por minuto retiene una plaza de subida (y su memoria) sin que nada lo
    // corte. Cada ventana debe traer al menos el ritmo mínimo; si no, se aborta con 408 y la plaza se libera.
    let checkedAt = 0;
    const pace = this.minBytesPerSecond > 0
      ? setInterval(() => {
          const received = sizeBytes - checkedAt;
          checkedAt = sizeBytes;
          if (received < (this.minBytesPerSecond * this.paceWindowMs) / 1000) {
            counter.destroy(new RequestTimeoutException("La subida es demasiado lenta; se cancela para liberar el servidor."));
          }
        }, this.paceWindowMs)
      : undefined;
    pace?.unref();

    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: counter, ContentType: contentType },
      queueSize: UPLOAD_QUEUE_SIZE,
      partSize: UPLOAD_PART_BYTES,
      leavePartsOnError: false, // si falla, se descartan las partes ya subidas
    });
    try {
      await upload.done();
    } catch (error) {
      clearInterval(pace);
      await upload.abort().catch(() => undefined);
      await this.delete(key).catch(() => undefined);
      // La librería envuelve los errores del flujo: si fue el límite (413) o el ritmo (408), se devuelve el original.
      if (counter.errored instanceof HttpException) throw counter.errored;
      // El cliente cortó la conexión a mitad de la subida: no es un fallo del servidor.
      if ((counter.errored as NodeJS.ErrnoException | null)?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        throw new BadRequestException("La subida se interrumpió antes de terminar.");
      }
      throw error;
    }
    clearInterval(pace);
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
