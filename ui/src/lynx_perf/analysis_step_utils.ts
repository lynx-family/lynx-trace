import {uuidv4} from '../base/uuid';
import {AnalysisStep, EventData} from './llm_state';

type ProgressEventType =
  | 'agent_start'
  | 'agent_end'
  | 'tool_call'
  | 'error'
  | 'finish'
  | 'summary';
type StepStatus = 'wait' | 'process' | 'finish' | 'error';

export type ProgressEventDetails = {
  agent_start: {initialMessages?: Array<{role: string; content: unknown}>};
  agent_end: {result?: unknown};
  tool_call: {
    args: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
    toolName: string;
  };
  error: {errorMessage: string};
  finish: {result: string};
  summary: {summaryMessage: string};
};

interface ProgressEvent<T extends ProgressEventType = ProgressEventType> {
  type: T;
  agentId: string;
  parentAgentId?: string;
  agentName: string;
  details: T extends keyof ProgressEventDetails
    ? ProgressEventDetails[T]
    : Record<string, unknown>;
}

export function getEventTitle(
  type: ProgressEventType,
  agentName: string,
  details: unknown,
): string {
  switch (type) {
    case 'agent_start':
      return `Agent Start: ${agentName ?? 'Unknown Agent'}`;
    case 'agent_end':
      return `Agent End: ${agentName ?? 'Unknown Agent'}`;
    case 'tool_call':
      return `Tool: ${(details as ProgressEventDetails['tool_call']).toolName}`;
    case 'error':
      return 'Error';
    case 'summary':
      return 'Summary';
    case 'finish':
      return 'Analysis completed';
    default:
      return 'Unknown Message';
  }
}

export function getEventStatus(type: ProgressEventType): StepStatus {
  if (type === 'error') return 'error';
  if (
    type === 'finish' ||
    type === 'tool_call' ||
    type === 'agent_end' ||
    type === 'summary'
  ) {
    return 'finish';
  }
  return 'process';
}

export function generateStepIds(event: ProgressEvent): {
  stepId: string;
  parentStepId: string | undefined;
} {
  let stepId = `${event.type}`;
  if (event.type === 'tool_call' || event.type === 'summary') {
    stepId = `${uuidv4()}`;
  }
  let parentStepId: string | undefined;

  if (event.type === 'agent_start') {
    parentStepId = undefined;
  } else if (event.type !== 'finish') {
    parentStepId = 'agent_start';
  }

  return {stepId, parentStepId};
}

function isAnalysisStep(d: unknown): d is AnalysisStep {
  return d !== null && typeof d === 'object' && 'id' in d;
}

function addOrUpdateChild(
  parent: AnalysisStep,
  childId: string,
  title: string,
  status: StepStatus,
  content: string,
): AnalysisStep {
  const details = Array.isArray(parent.details) ? parent.details : [];
  const idx = details.findIndex(
    (d): d is AnalysisStep => isAnalysisStep(d) && d.id === childId,
  );

  if (idx === -1) {
    return {
      ...parent,
      details: [
        ...details,
        {
          id: childId,
          title,
          status,
          details: content ? [content] : [],
          collapsed: false,
        },
      ],
    };
  }

  const child = details[idx] as AnalysisStep;
  const updatedChild: AnalysisStep = {
    ...child,
    status,
    details: content ? [...child.details, content] : child.details,
  };

  const newDetails = [...details];
  newDetails[idx] = updatedChild;
  return {...parent, details: newDetails};
}

function updateStep(
  s: AnalysisStep,
  stepId: string,
  title: string,
  status: StepStatus,
  content: string,
  childStepId: string,
): {step: AnalysisStep; found: boolean} {
  if (s.id === stepId) {
    if (childStepId) {
      return {
        step: addOrUpdateChild(s, childStepId, title, status, content),
        found: true,
      };
    }
    return {
      step: {
        ...s,
        status,
        details: content ? [...s.details, content] : s.details,
      },
      found: true,
    };
  }

  if (Array.isArray(s.details) && s.details.length > 0) {
    let found = false;
    const newDetails = s.details.map((d) => {
      if (isAnalysisStep(d)) {
        const res = updateStep(d, stepId, title, status, content, childStepId);
        if (res.found) found = true;
        return res.step;
      }
      return d;
    });
    if (found) return {step: {...s, details: newDetails}, found: true};
  }

  return {step: s, found: false};
}

function updateAtAnyDepth(
  steps: AnalysisStep[],
  stepId: string,
  title: string,
  status: StepStatus,
  content: string,
  childStepId: string,
): {updated: AnalysisStep[]; found: boolean} {
  let found = false;
  const updated = steps.map((s) => {
    if (found) return s;
    const res = updateStep(s, stepId, title, status, content, childStepId);
    if (res.found) {
      found = true;
      return res.step;
    }
    return s;
  });
  return {updated, found};
}

function createNewStep(
  steps: AnalysisStep[],
  stepId: string,
  title: string,
  status: StepStatus,
  content: string,
  childStepId: string,
): AnalysisStep[] {
  if (childStepId) {
    const newParent: AnalysisStep = {
      id: stepId,
      title: `Agent Start: ${stepId.split('-')[0]}`,
      status: 'process',
      details: [
        {
          id: childStepId,
          title,
          status,
          details: content ? [content] : [],
          collapsed: false,
        },
      ],
      collapsed: false,
    };
    return [...steps, newParent];
  }

  const existingIndex = steps.findIndex((step) => step.id === stepId);
  if (existingIndex !== -1) {
    const updatedSteps = [...steps];
    const existing = updatedSteps[existingIndex];
    updatedSteps[existingIndex] = {
      ...existing,
      title,
      status,
      details: content ? [...existing.details, content] : existing.details,
    };
    return updatedSteps;
  }

  return [
    ...steps,
    {
      id: stepId,
      title,
      status,
      details: content ? [content] : [],
      collapsed: false,
    },
  ];
}

export function updateAnalysisSteps(
  steps: AnalysisStep[],
  stepId: string,
  title: string,
  status: StepStatus,
  content: string,
  childStepId: string = '',
): AnalysisStep[] {
  const {updated, found} = updateAtAnyDepth(
    steps,
    stepId,
    title,
    status,
    content,
    childStepId,
  );
  if (found) {
    return updated;
  }
  return createNewStep(steps, stepId, title, status, content, childStepId);
}

export function eventDataToAnalysisStep(eventData: EventData): AnalysisStep {
  const {event} = eventData;
  const {stepId, parentStepId} = generateStepIds(event);
  const title = getEventTitle(event.type, event.agentName, event.details);
  const status = getEventStatus(event.type);
  const content = JSON.stringify(event.details);

  if (parentStepId) {
    const childStep: AnalysisStep = {
      id: stepId,
      title,
      status,
      details: content ? [content] : [],
      collapsed: false,
    };

    return {
      id: parentStepId,
      title: `Agent Start: ${event.agentId}`,
      status: event.type === 'agent_end' ? 'finish' : 'process',
      details: [childStep],
      collapsed: false,
    };
  }

  return {
    id: stepId,
    title,
    status,
    details: content ? [content] : [],
    collapsed: false,
  };
}

export function convertEventDataArrayToAnalysisSteps(
  events: EventData[],
): AnalysisStep[] {
  let steps: AnalysisStep[] = [];

  for (const eventData of events) {
    const {event} = eventData;
    const {stepId, parentStepId} = generateStepIds(event);
    const title = getEventTitle(event.type, event.agentName, event.details);
    const status = getEventStatus(event.type);
    const content = JSON.stringify(event.details);

    if (event.type === 'agent_end' && parentStepId) {
      steps = updateAnalysisSteps(
        steps,
        parentStepId,
        `Agent Start: ${event.agentId}`,
        'finish',
        '',
        '',
      );
    }

    steps = updateAnalysisSteps(
      steps,
      parentStepId ?? stepId,
      title,
      status,
      content,
      parentStepId ? stepId : '',
    );
  }

  return steps;
}
