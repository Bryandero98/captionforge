import { Inject, Injectable } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

/** Topes de operaciones largas simultáneas (ver ConcurrencyLimiter). Un solo juego por aplicación. */
@Injectable()
export class ConnectionLimits {
  readonly uploads: ConcurrencyLimiter;
  readonly eventStreams: ConcurrencyLimiter;
  readonly eventStreamMaxMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const { maxConcurrentUploads, maxEventStreams, maxEventStreamsPerClient, eventStreamMaxMs } = config.security;
    this.uploads = new ConcurrencyLimiter({ total: maxConcurrentUploads, perKey: 0 });
    this.eventStreams = new ConcurrencyLimiter({ total: maxEventStreams, perKey: maxEventStreamsPerClient });
    this.eventStreamMaxMs = eventStreamMaxMs;
  }
}
