import type { FastifyInstance } from 'fastify';
import type { SwappableTranscribeProvider } from '@core/transcribe/index.js';
import type { ScanJobService } from '../services/scan-job.service.js';
import type { AttributionService } from '../services/attribution.service.js';
import { registerConfigRoutes } from './config.js';
import { registerHealthRoutes } from './health.js';
import { registerBrowseRoutes } from './browse.js';
import { registerLibraryRoutes } from './library.js';
import { registerScanRoutes } from './scans.js';
import { registerAttributionRoutes } from './attribution.js';
import { registerDebugRoutes } from './debug.js';
import { registerSettingsRoutes } from './settings.js';

export function registerRoutes(
  app: FastifyInstance,
  deps: { scans: ScanJobService; attribution: AttributionService; transcribe: SwappableTranscribeProvider },
): void {
  registerConfigRoutes(app);
  registerHealthRoutes(app);
  registerBrowseRoutes(app);
  registerLibraryRoutes(app);
  registerScanRoutes(app, deps.scans);
  registerAttributionRoutes(app, deps.attribution);
  registerDebugRoutes(app, deps.attribution);
  registerSettingsRoutes(app, deps.transcribe);
}
