/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Step from '@mui/material/Step';
import StepConnector, { stepConnectorClasses } from '@mui/material/StepConnector';
import { StepIconProps } from '@mui/material/StepIcon';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import { styled, useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Event from '../../lib/k8s/event';
import Node from '../../lib/k8s/node';

/**
 * The 5 stages of a regular node upgrade, in order.
 */
const UPGRADE_STAGES = ['cordon', 'drain', 'deleteNode', 'reimage', 'completed'] as const;
type UpgradeStage = (typeof UPGRADE_STAGES)[number];

function getStageLabelTranslated(stage: UpgradeStage, t: (key: string) => string): string {
  switch (stage) {
    case 'cordon':
      return t('Cordon');
    case 'drain':
      return t('Drain');
    case 'deleteNode':
      return t('Delete');
    case 'reimage':
      return t('Reimage');
    case 'completed':
      return t('Complete');
  }
}

/**
 * Iconify icon names for each stage.
 */
const STAGE_ICONS: Record<UpgradeStage, string> = {
  cordon: 'mdi:lock',
  drain: 'mdi:clipboard-arrow-down',
  deleteNode: 'mdi:delete',
  reimage: 'mdi:timer-sand',
  completed: 'mdi:check-circle',
};

interface NodeUpgradeState {
  nodeName: string;
  isSurge: boolean;
  isUpgrading: boolean;
  currentStage: UpgradeStage | null;
  failedStage: UpgradeStage | null;
  failureMessage: string | null;
  /** Timestamp (ISO string) when each stage started */
  stageTimestamps: Partial<Record<UpgradeStage, string>>;
}

/**
 * Check if any node in the list is an AKS-managed node.
 * Detection uses multiple signals:
 * - providerID starting with "azure://"
 * - "kubernetes.azure.com/cluster" label
 */
export function hasAKSManagedNodes(nodes: Node[]): boolean {
  return nodes.some(node => {
    // Check providerID for Azure provider
    const providerID = node.jsonData?.spec?.providerID || '';
    if (providerID.startsWith('azure://')) {
      return true;
    }

    // Check for AKS-specific label
    const labels = node.metadata.labels || {};
    if ('kubernetes.azure.com/cluster' in labels) {
      return true;
    }

    return false;
  });
}

/**
 * event-matching constants for AKS node upgrade detection.
 * These message substrings come from the AKS and are used to identify upgrade stages from Kubernetes events.
 * AKS have test to guarantee these messages remain consistent
 * If there is a need to change the event or add more event, first change in AKS RP code,
 * after the release roll out, update these constants and the event processing logic accordingly.
 */
const EVENT_REASONS = {
  UPGRADE: 'Upgrade',
  SURGE: 'Surge',
  CORDON: 'Cordon',
  DRAIN: 'Drain',
} as const;

export const EVENT_REASON_VALUES = new Set<string>(Object.values(EVENT_REASONS));

/**
 * Field selector to exclude Pod events (which are the vast majority).
 * Visualization only need node and namespace scope events.
 * Excluding Pod events significantly reduces the number of events to process.
 */
export const UPGRADE_EVENT_FIELD_SELECTOR = 'involvedObject.kind!=Pod';

const EVENT_MESSAGES = {
  UPGRADE_STARTED: 'Upgrade started for agent pool',
  SURGE_CREATED: 'Created a surge node',
  CORDONING: 'Cordoning node',
  DRAINING: 'Draining node',
  DELETING_NODE: 'Deleting node',
  DELETING_FROM_API: 'from API server',
  REIMAGING: 'Reimaging node',
  SUCCESSFULLY_REIMAGED: 'Successfully reimaged node',
  SUCCESSFULLY_UPGRADED: 'Successfully upgraded node',
  DRAINING_ERROR: 'Error draining node',
  UNABLE_TO_DELETE: 'Unable to delete node',
  FAILED_TO_REIMAGE: 'Failed to reimage node',
} as const;

/**
 * Determine if an upgrade is happening by checking for upgrade start, surge or reimage events.
 */
export function isUpgradeDetected(events: Event[]): boolean {
  return events.some(event => {
    const reason = event.reason;
    const message = event.message || '';
    if (reason === EVENT_REASONS.UPGRADE && message.includes(EVENT_MESSAGES.UPGRADE_STARTED)) {
      return true;
    }
    if (reason === EVENT_REASONS.SURGE && message.includes(EVENT_MESSAGES.SURGE_CREATED)) {
      return true;
    }
    if (
      reason === EVENT_REASONS.UPGRADE &&
      message.includes(EVENT_MESSAGES.SUCCESSFULLY_REIMAGED)
    ) {
      return true;
    }
    return false;
  });
}

/**
 * Build upgrade state for each node by processing events.
 */
export function buildNodeUpgradeStates(
  nodes: Node[],
  events: Event[]
): Map<string, NodeUpgradeState> {
  const stateMap = new Map<string, NodeUpgradeState>();

  // Initialize all nodes
  for (const node of nodes) {
    const name = node.metadata.name;
    if (!name) continue;
    stateMap.set(name, {
      nodeName: name,
      isSurge: false,
      isUpgrading: false,
      currentStage: null,
      failedStage: null,
      failureMessage: null,
      stageTimestamps: {},
    });
  }

  // Sort events by creation timestamp (oldest first)
  const sortedEvents = [...events]
    .filter(e => e.involvedObject?.kind === 'Node')
    .sort((a, b) => {
      const timeA = new Date(a.metadata.creationTimestamp || 0).getTime();
      const timeB = new Date(b.metadata.creationTimestamp || 0).getTime();
      return timeA - timeB;
    });

  for (const event of sortedEvents) {
    const nodeName = event.involvedObject?.name;
    if (!nodeName) continue;

    // Ensure node exists in state map (could be an event for a node not yet in node list)
    if (!stateMap.has(nodeName)) {
      stateMap.set(nodeName, {
        nodeName,
        isSurge: false,
        isUpgrading: false,
        currentStage: null,
        failedStage: null,
        failureMessage: null,
        stageTimestamps: {},
      });
    }

    const state = stateMap.get(nodeName)!;
    const reason = event.reason || '';
    const message = event.message || '';
    const eventType = event.type || 'Normal';
    const eventTime = event.metadata.creationTimestamp || '';

    // Once completed, state is immutable
    if (state.currentStage === 'completed') {
      continue;
    }

    // Check for surge node
    if (reason === EVENT_REASONS.SURGE && message.includes(EVENT_MESSAGES.SURGE_CREATED)) {
      state.isSurge = true;
      continue;
    }

    // Process regular upgrade stages
    if (reason === EVENT_REASONS.CORDON && message.includes(EVENT_MESSAGES.CORDONING)) {
      state.isUpgrading = true;
      state.currentStage = 'cordon';
      if (!state.stageTimestamps.cordon) {
        state.stageTimestamps.cordon = eventTime;
      }
      continue;
    }

    if (reason === EVENT_REASONS.DRAIN && message.includes(EVENT_MESSAGES.DRAINING)) {
      state.isUpgrading = true;
      state.currentStage = 'drain';
      if (!state.stageTimestamps.drain) {
        state.stageTimestamps.drain = eventTime;
      }
      continue;
    }

    if (
      reason === EVENT_REASONS.UPGRADE &&
      message.includes(EVENT_MESSAGES.DELETING_NODE) &&
      message.includes(EVENT_MESSAGES.DELETING_FROM_API)
    ) {
      state.isUpgrading = true;
      state.currentStage = 'deleteNode';
      if (!state.stageTimestamps.deleteNode) {
        state.stageTimestamps.deleteNode = eventTime;
      }
      continue;
    }

    if (reason === EVENT_REASONS.UPGRADE && message.includes(EVENT_MESSAGES.REIMAGING)) {
      state.isUpgrading = true;
      state.currentStage = 'reimage';
      if (!state.stageTimestamps.reimage) {
        state.stageTimestamps.reimage = eventTime;
      }
      continue;
    }

    if (
      reason === EVENT_REASONS.UPGRADE &&
      message.includes(EVENT_MESSAGES.SUCCESSFULLY_UPGRADED)
    ) {
      state.isUpgrading = true;
      state.currentStage = 'completed';
      if (!state.stageTimestamps.completed) {
        state.stageTimestamps.completed = eventTime;
      }
      continue;
    }

    // Handle failures (Warning-type events)
    if (eventType === 'Warning') {
      if (reason === EVENT_REASONS.CORDON && message.toLowerCase().includes('failed')) {
        state.failedStage = 'cordon';
        state.failureMessage = message;
        continue;
      }
      if (reason === EVENT_REASONS.DRAIN && message.includes(EVENT_MESSAGES.DRAINING_ERROR)) {
        state.failedStage = 'drain';
        state.failureMessage = message;
        continue;
      }
      if (reason === EVENT_REASONS.UPGRADE && message.includes(EVENT_MESSAGES.UNABLE_TO_DELETE)) {
        state.failedStage = 'deleteNode';
        state.failureMessage = message;
        continue;
      }
      if (reason === EVENT_REASONS.UPGRADE && message.includes(EVENT_MESSAGES.FAILED_TO_REIMAGE)) {
        state.failedStage = 'reimage';
        state.failureMessage = message;
        continue;
      }
    }
  }

  return stateMap;
}

/**
 * Format a timestamp string to a locale time string like "09:36:43 AM".
 */
function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Custom connector line between steps — green when completed, primary when active.
 */
const UpgradeStepConnector = styled(StepConnector)(({ theme }) => ({
  [`&.${stepConnectorClasses.completed}`]: {
    [`& .${stepConnectorClasses.line}`]: {
      borderColor: theme.palette.success.main,
    },
  },
  [`&.${stepConnectorClasses.active}`]: {
    [`& .${stepConnectorClasses.line}`]: {
      borderColor: theme.palette.success.main,
    },
  },
  [`& .${stepConnectorClasses.line}`]: {
    borderColor: theme.palette.grey[400],
    borderTopWidth: 3,
    borderRadius: 1,
  },
}));

/**
 * Custom step icon component that renders an Iconify icon inside a colored circle.
 */
function UpgradeStepIcon(props: StepIconProps & { stage: UpgradeStage; isFailed: boolean }) {
  const { active, completed, stage, isFailed } = props;
  const theme = useTheme();

  let bgColor = theme.palette.grey[400];
  const iconColor = '#fff';

  if (isFailed) {
    bgColor = theme.palette.error.main;
  } else if (completed) {
    bgColor = theme.palette.success.main;
  } else if (active) {
    bgColor = theme.palette.primary.main;
  }

  return (
    <Box
      sx={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        backgroundColor: bgColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: active ? `0 0 0 4px ${bgColor}40` : 'none',
      }}
    >
      <Icon icon={STAGE_ICONS[stage]} width={22} height={22} color={iconColor} />
    </Box>
  );
}

/**
 * Renders the upgrade stepper for a single upgrading node.
 */
function NodeUpgradeStepper({ state, node }: { state: NodeUpgradeState; node: Node | undefined }) {
  const { t } = useTranslation(['translation']);
  const theme = useTheme();

  const activeStepIndex = state.currentStage ? UPGRADE_STAGES.indexOf(state.currentStage) : -1;

  const failedStepIndex = state.failedStage ? UPGRADE_STAGES.indexOf(state.failedStage) : -1;

  const isReady = node?.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True';
  const version = node?.status?.nodeInfo?.kubeletVersion;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      {/* Header: node name + Ready badge + version */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            {state.nodeName}
          </Typography>
          {isReady && <Chip label={t('Ready')} size="small" color="success" variant="outlined" />}
        </Box>
        {version && (
          <Typography variant="body2" sx={{ color: theme.palette.primary.main, fontWeight: 500 }}>
            {t('Version: {{ version }}', { version })}
          </Typography>
        )}
      </Box>

      {/* Stepper */}
      <Stepper activeStep={activeStepIndex} alternativeLabel connector={<UpgradeStepConnector />}>
        {UPGRADE_STAGES.map((stage, index) => {
          const isFailed = index === failedStepIndex;
          const isCompleted =
            index < activeStepIndex ||
            (stage === 'completed' && state.currentStage === 'completed');
          const isActive = index === activeStepIndex;
          const timestamp = state.stageTimestamps[stage];

          return (
            <Step key={stage} completed={isCompleted}>
              <StepLabel
                error={isFailed}
                StepIconComponent={(iconProps: StepIconProps) => (
                  <UpgradeStepIcon
                    {...iconProps}
                    stage={stage}
                    isFailed={isFailed}
                    completed={isCompleted}
                    active={isActive}
                  />
                )}
                optional={
                  isFailed && state.failureMessage ? (
                    <Typography
                      variant="caption"
                      sx={{
                        display: 'block',
                        maxWidth: 200,
                        wordBreak: 'break-word',
                        whiteSpace: 'normal',
                        textAlign: 'center',
                      }}
                    >
                      {state.failureMessage}
                    </Typography>
                  ) : timestamp ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', textAlign: 'center' }}
                    >
                      {formatTimestamp(timestamp)}
                    </Typography>
                  ) : undefined
                }
                sx={{
                  '& .MuiStepLabel-label': {
                    fontWeight: isActive ? 'bold' : 'normal',
                    mt: 0.5,
                    ...(isCompleted &&
                      !isFailed && {
                        color: `${theme.palette.success.main} !important`,
                      }),
                    ...(isFailed && {
                      color: `${theme.palette.error.main} !important`,
                    }),
                    ...(isActive &&
                      !isFailed && {
                        color: `${theme.palette.primary.main} !important`,
                      }),
                  },
                }}
              >
                {getStageLabelTranslated(stage, t)}
              </StepLabel>
            </Step>
          );
        })}
      </Stepper>
    </Paper>
  );
}

/**
 * Renders a single non-upgrading node row with Ready badge and version.
 */
function NodeIdleRow({ state, node }: { state: NodeUpgradeState; node: Node | undefined }) {
  const { t } = useTranslation(['translation']);
  const isReady = node?.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True';
  const version = node?.status?.nodeInfo?.kubeletVersion;

  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5, mb: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle2">{state.nodeName}</Typography>
        {isReady && <Chip label={t('Ready')} size="small" color="success" variant="outlined" />}
        {state.isSurge && <Chip label={t('Surge Node')} size="small" color="info" />}
      </Box>
      {version && (
        <Typography variant="body2" sx={{ color: 'primary.main', fontWeight: 500 }}>
          {t('Version: {{ version }}', { version })}
        </Typography>
      )}
    </Paper>
  );
}

/**
 * Upgrade Visualization Panel.
 * Shown below the node list table when an upgrade is detected.
 * Gates on AKS-managed nodes so non-AKS clusters never pay the event-fetch cost.
 */
export default function UpgradeVisualizationPanel({ nodes }: { nodes: Node[] | null }) {
  const isAKSCluster = useMemo(() => {
    if (!nodes) return false;
    return hasAKSManagedNodes(nodes);
  }, [nodes]);

  if (!isAKSCluster) {
    return null;
  }

  return <UpgradeVisualizationPanelInner nodes={nodes!} />;
}

/**
 * Inner panel that fetches events and renders upgrade progress.
 * Only mounted when AKS nodes are detected.
 */
function UpgradeVisualizationPanelInner({ nodes }: { nodes: Node[] }) {
  const { t } = useTranslation(['translation']);
  const { items: allEvents } = Event.useList({
    limit: Event.maxLimit,
    fieldSelector: UPGRADE_EVENT_FIELD_SELECTOR,
  });

  const events = useMemo(
    () => allEvents?.filter(e => e.reason && EVENT_REASON_VALUES.has(e.reason)) ?? null,
    [allEvents]
  );

  const upgradeDetected = useMemo(() => {
    if (!events) return false;
    return isUpgradeDetected(events);
  }, [events]);

  const nodeStates = useMemo(() => {
    if (!nodes || !events) return new Map<string, NodeUpgradeState>();
    return buildNodeUpgradeStates(nodes, events);
  }, [nodes, events]);

  if (!upgradeDetected) {
    return null;
  }

  // Build a lookup map from node name to Node object
  const nodeMap = new Map<string, Node>();
  for (const node of nodes) {
    const name = node.metadata.name;
    if (!name) continue;
    nodeMap.set(name, node);
  }

  const states = Array.from(nodeStates.values());
  const upgradingNodes = states.filter(
    s => s.isUpgrading && !s.isSurge && s.currentStage !== 'completed'
  );
  const surgeNodes = states.filter(s => s.isSurge && nodeMap.has(s.nodeName));
  const idleNodes = states.filter(
    s =>
      ((!s.isUpgrading && !s.isSurge) || s.currentStage === 'completed') && nodeMap.has(s.nodeName)
  );

  return (
    <Box sx={{ mt: 2, ml: 1, mr: 1 }}>
      {/* Upgrading nodes with steppers */}
      {upgradingNodes.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 'bold' }}>
            {t('Upgrading Nodes')}
          </Typography>
          {upgradingNodes.map(state => (
            <NodeUpgradeStepper
              key={state.nodeName}
              state={state}
              node={nodeMap.get(state.nodeName)}
            />
          ))}
        </Box>
      )}

      {/* Surge nodes */}
      {surgeNodes.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 'bold' }}>
            {t('Surge Nodes')}
          </Typography>
          {surgeNodes.map(state => (
            <NodeIdleRow key={state.nodeName} state={state} node={nodeMap.get(state.nodeName)} />
          ))}
        </Box>
      )}

      {/* Idle (non-upgrading) nodes */}
      {idleNodes.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 'bold' }}>
            {t('Idle Nodes')}
          </Typography>
          {idleNodes.map(state => (
            <NodeIdleRow key={state.nodeName} state={state} node={nodeMap.get(state.nodeName)} />
          ))}
        </Box>
      )}
    </Box>
  );
}
