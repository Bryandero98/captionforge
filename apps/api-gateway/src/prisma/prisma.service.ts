import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaClient } from "../generated/prisma/client.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // PrismaPg (node-postgres) ignora `connection_limit` de la URL: el tamaño del pool va aquí y debe
    // quedar por debajo del CONNECTION LIMIT del rol cf_api (20, docker/postgres/init-roles.sql).
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 10_000 }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
