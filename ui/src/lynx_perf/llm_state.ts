// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {createStore} from '../base/store';

export interface LLMConfig {
  modelProvider: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
  customPrompt?: string;
}

export interface AnalysisStep {
  id: string;
  title: string;
  status: 'wait' | 'process' | 'finish' | 'error';
  details: (string | AnalysisStep)[];
  collapsed?: boolean;
}

export interface StepListener {
  onStepUpdate(
    stepId: string,
    title: string,
    status: 'wait' | 'process' | 'finish' | 'error',
    content: string,
    childStepId?: string,
  ): void;
}

export interface AnalysisReport {
  analysisResult: string;
  extraActionProperties: Record<string, string>;
  analysisSteps: AnalysisStep[];
  extraActionArea?: React.ReactNode;
}

export interface ReportExtraAction {
  render(
    results: string,
    steps: AnalysisStep[] | undefined,
    actionProperties: Record<string, string> | undefined,
  ): Promise<React.ReactNode | undefined>;

  getActionProperties(): Record<string, string> | undefined;

  getHistoryAnalysisReport(): Promise<AnalysisReport | undefined>;

  saveAnalysisReport(result: AnalysisReport): Promise<boolean>;
}

export interface TraceAnalysis {
  analysis(stepListener: StepListener): Promise<AnalysisReport | undefined>;
}

interface State {
  showAnalysisEntry: boolean;
  config: LLMConfig;
  modelChoosePanel: React.ReactNode | undefined;
  reportExtraAction: ReportExtraAction | undefined;
  traceAnalysis: TraceAnalysis | undefined;
  pendingStartAnalysis: boolean;
}

const emptyState: State = {
  showAnalysisEntry: false,
  config: {
    modelProvider: '',
    modelName: '',
    apiKey: '',
    baseUrl: '',
    customPrompt: '',
  },
  modelChoosePanel: undefined,
  reportExtraAction: undefined,
  traceAnalysis: undefined,
  pendingStartAnalysis: false,
};

export const llmState = createStore<State>(emptyState);

export function updateLLMConfig(config: LLMConfig) {
  llmState.edit((draft) => {
    Object.assign(draft.config, config);
  });
}

export function updateReportExtraAction(
  extraAction: ReportExtraAction | undefined,
) {
  llmState.edit((draft) => {
    draft.reportExtraAction = extraAction;
  });
}
