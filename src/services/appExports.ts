import { config } from "../config/index.js";
import { validateStorageEndpoint } from "../lib/storageEndpoint.js";
import type { UsageEventsRepository } from "../repositories/usageEventsRepository.js";
import { HmacObjectStorageClient, InMemoryScheduleStore, ScheduledExportsService } from "./scheduledExports.js";
import { InMemoryExportStore, ReportExporterService } from "./reportExporter.js";

export function createAppExports(usageEventsRepository: UsageEventsRepository) {
  const getExportEvents = async () => {
    const events = await usageEventsRepository.getEvents?.();
    if (!events) {
      throw new Error('The configured usage repository does not support export event retrieval.');
    }
    return events.map((event) => ({
      id: event.id,
      userId: event.userId,
      apiId: event.apiId,
      endpointId: event.endpoint,
      apiKeyId: '',
      developerId: event.developerId,
      amount: event.revenue,
      requestId: event.id,
      stellarTxHash: event.stellarTxHash ?? null,
      createdAt: event.occurredAt,
    }));
  };
  const exportConfig = config.exports;
  const exportsConfigured = Boolean(
    exportConfig.enabled &&
      exportConfig.bucket &&
      exportConfig.endpoint &&
      exportConfig.region &&
      exportConfig.signingSecret,
  );
  const objectStorageClient = new HmacObjectStorageClient();
  const exportEndpoint = exportsConfigured
    ? validateStorageEndpoint(exportConfig.endpoint!, {
        production: config.nodeEnv === 'production',
        allowedHosts: exportConfig.endpointAllowlist,
      })
    : undefined;
  const reportExporterService = exportsConfigured
    ? new ReportExporterService(
        {
          // Adapt the in-process repository to the paged range interface:
          // [from, to) by createdAt, optional developer filter, id keyset cursor.
          getEventsInRange: async (from, to, options) => {
            const events = (await getExportEvents())
              .filter((event) => event.createdAt >= from && event.createdAt < to)
              .filter((event) => options.developerId === undefined || event.developerId === options.developerId)
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const start = options.cursor === undefined
              ? 0
              : events.findIndex((event) => event.id > options.cursor!);
            if (start === -1) return [];
            return events.slice(start, start + options.limit);
          },
        },
        objectStorageClient,
        new InMemoryExportStore(),
        {
          s3Bucket: exportConfig.bucket!,
          s3Endpoint: exportEndpoint!,
          s3SecretAccessKey: exportConfig.signingSecret!,
        },
      )
    : undefined;
  const scheduledExportsService = exportsConfigured
    ? new ScheduledExportsService(
        {
          findByApiId: async (apiId, from, to, limit, offset) =>
            (await getExportEvents())
              .filter((event) => !apiId || event.apiId === apiId)
              .filter((event) => !from || event.createdAt >= from)
              .filter((event) => !to || event.createdAt <= to)
              .slice(offset ?? 0, limit === undefined ? undefined : (offset ?? 0) + limit),
        },
        new InMemoryScheduleStore(exportConfig.signingSecret!),
        objectStorageClient,
      )
    : undefined;

  return { reportExporterService, scheduledExportsService };
}
