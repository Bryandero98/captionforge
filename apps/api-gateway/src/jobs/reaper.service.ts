import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { QueueService } from "../queue/queue.service.js";

/**
 * Cierra trabajos que quedaron huérfanos. Sin esto, la fila de un trabajo cuyo worker murió (falta de
 * memoria, corte) diría RUNNING para siempre y la persona usuaria vería una barra de progreso congelada.
 *
 * - RUNNING sin ningún cambio en `updatedAt` durante JOB_STALE_MINUTES: el worker escribe el progreso
 *   varias veces por minuto en cualquier etapa, así que un silencio tan largo es un worker muerto.
 *   (El worker también cierra los atascados que detecta BullMQ; esto cubre que NO quede ningún worker.)
 * - QUEUED que ya no existe en Redis tras QUEUED_GRACE_MINUTES: Redis perdió la cola (reinicio sin
 *   persistencia) o el proceso murió entre crear la fila y encolar.
 *
 * Las dos escrituras son condicionales (`WHERE status = ...`): si el trabajo avanzó entre la lectura y
 * la escritura, no se pisa.
 */
@Injectable()
export class ReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReaperService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const { intervalMs } = this.config.reaper;
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref(); // nunca retiene el proceso al apagar
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // una pasada lenta no se solapa con la siguiente
    this.running = true;
    try {
      const { stuckRunning, lostQueued } = await this.reapOnce();
      if (stuckRunning + lostQueued > 0) {
        this.logger.warn(`Trabajos huérfanos cerrados: ${stuckRunning} sin respuesta, ${lostQueued} perdidos de la cola.`);
      }
    } catch (error) {
      this.logger.error(`El recolector falló: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async reapOnce(now: Date = new Date()): Promise<{ stuckRunning: number; lostQueued: number }> {
    const { staleRunningMs, queuedGraceMs } = this.config.reaper;

    const staleBefore = new Date(now.getTime() - staleRunningMs);
    const stale = await this.prisma.job.findMany({
      where: { status: "RUNNING", updatedAt: { lt: staleBefore } },
      select: { id: true },
      take: 200,
    });
    const stuck = await this.prisma.job.updateMany({
      where: { id: { in: stale.map((job) => job.id) }, status: "RUNNING", updatedAt: { lt: staleBefore } },
      data: {
        status: "FAILED",
        errorCode: "INTERNAL",
        errorMessage: "El trabajo dejó de responder y se cerró. Vuelve a intentarlo.",
        finishedAt: now,
      },
    });

    // Si el worker sigue vivo (solo estaba callado), que deje de gastar CPU en un trabajo que ya se dio por cerrado.
    for (const { id } of stale) {
      await this.queue.requestCancel(id).catch((e: unknown) => this.logger.warn(`No se pudo avisar de la cancelación de ${id}: ${(e as Error).message}`));
    }

    let lostQueued = 0;
    const waiting = await this.prisma.job.findMany({
      where: { status: "QUEUED", createdAt: { lt: new Date(now.getTime() - queuedGraceMs) } },
      select: { id: true, kind: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    for (const { id, kind } of waiting) {
      if (await this.queue.exists(kind, id)) continue;
      const closed = await this.prisma.job.updateMany({
        where: { id, status: "QUEUED" },
        data: {
          status: "FAILED",
          errorCode: "INTERNAL",
          errorMessage: "El trabajo se perdió de la cola. Vuelve a intentarlo.",
          finishedAt: now,
        },
      });
      lostQueued += closed.count;
    }
    return { stuckRunning: stuck.count, lostQueued };
  }
}
