"""Cliente S3 del worker (boto3). Todas las operaciones son bloqueantes: se llaman desde hilos."""

from __future__ import annotations

from pathlib import Path

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from .config import WorkerConfig


class ObjectNotFound(Exception):
    """El objeto de entrada no existe en el almacenamiento."""


class Storage:
    def __init__(self, config: WorkerConfig) -> None:
        self.bucket = config.s3_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=config.s3_endpoint,
            region_name=config.s3_region,
            aws_access_key_id=config.s3_access_key,
            aws_secret_access_key=config.s3_secret_key,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                retries={"max_attempts": 5, "mode": "standard"},
                # Los S3 que no son AWS no siempre aceptan las sumas de verificación nuevas por defecto.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    def download(self, bucket: str, key: str, destination: Path) -> int:
        """Descarga a disco (multiparte automática). Devuelve los bytes escritos."""
        try:
            self._client.download_file(bucket, key, str(destination))
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                raise ObjectNotFound(f"{bucket}/{key}") from error
            raise
        return destination.stat().st_size

    def upload_file(self, source: Path, key: str, content_type: str) -> str:
        """Sube un archivo y devuelve su ETag sin comillas (el contrato lo exige en minúsculas hex)."""
        self._client.upload_file(str(source), self.bucket, key, ExtraArgs={"ContentType": content_type})
        return self.etag(self.bucket, key)

    def etag(self, bucket: str, key: str) -> str:
        head = self._client.head_object(Bucket=bucket, Key=key)
        return str(head["ETag"]).strip('"')
