#!/usr/bin/env node
/**
 * Tracking DevLog Server - Issue & Feature Tracking
 * Provides issue tracking, feature tracking, weekly integration, and backup tools
 */

import { createDevlogServer, startServer } from './base-server.js';
import { issueTrackingTools } from '../tools/issue-tracking-tools.js';
import { featureTrackingTools } from '../tools/feature-tracking-tools.js';
import { weeklyIntegrationTools } from '../tools/weekly-integration-tools.js';
import { backupRecoveryTools } from '../tools/backup-recovery-tools.js';
import { taskTrackingTools } from '../tools/task-tracking-tools.js';

// Combine all tracking tools
const trackingTools = [
  // Issue tracking
  ...issueTrackingTools,
  
  // Feature tracking
  ...featureTrackingTools,
  
  // Weekly integration
  ...weeklyIntegrationTools,
  
  // Backup and recovery
  ...backupRecoveryTools,
  
  // Task tracking (time integration)
  taskTrackingTools.find(t => t.name === 'dokoro_task_track')!,
  taskTrackingTools.find(t => t.name === 'dokoro_task_list')!
].filter(Boolean);

const config = {
  name: 'dokoro-tracking',
  version: '1.0.0',
  description: 'Issue & Feature tracking tools with time integration and backup'
};

const server = createDevlogServer(config);

// Start the server
startServer(server, trackingTools, config).catch(console.error);