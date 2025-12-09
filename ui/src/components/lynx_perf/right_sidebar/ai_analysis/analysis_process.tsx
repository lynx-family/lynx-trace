// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import React from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Circle,
  Loader,
} from 'lucide-react';
import {AnalysisStep} from '../../../../lynx_perf/llm_state';

interface AnalysisProcessProps {
  steps: AnalysisStep[];
}

interface AnalysisStepItemProps {
  step: AnalysisStep;
}

interface AnalysisStepItemState {
  expanded: boolean;
}

class AnalysisStepItem extends React.Component<
  AnalysisStepItemProps,
  AnalysisStepItemState
> {
  constructor(props: AnalysisStepItemProps) {
    super(props);
    this.state = {expanded: false};
  }

  toggle = () => {
    this.setState((prev) => ({expanded: !prev.expanded}));
  };

  getStatusIcon(status: string) {
    switch (status) {
      case 'finish':
        return <CheckCircle size={16} style={{color: '#22c55e'}} />;
      case 'process':
        return (
          <Loader
            size={16}
            style={{
              color: '#3b82f6',
              animation: 'ai-analysis-spin 1s linear infinite',
            }}
          />
        );
      case 'error':
        return <Circle size={16} style={{color: '#ef4444'}} />;
      default:
        return <Circle size={16} style={{color: '#d1d5db'}} />;
    }
  }

  renderDetail(detail: string | AnalysisStep, idx: number) {
    if (typeof detail === 'string') {
      return (
        <div
          key={idx}
          style={{
            fontSize: '0.875rem',
            color: '#6b7280',
            lineHeight: 1.5,
            paddingLeft: '8px',
            borderLeft: '2px solid #d1d5db',
            wordBreak: 'break-word',
            overflowWrap: 'break-word',
            maxWidth: '100%',
          }}>
          • {detail}
        </div>
      );
    }
    return <AnalysisStepItem key={detail.id || idx} step={detail} />;
  }

  render() {
    const {step} = this.props;
    const {expanded} = this.state;
    const hasDetails = step.details.length > 0;

    return (
      <div
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: '12px',
          boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
          transition: 'all 0.3s ease-in-out',
        }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px',
            cursor: hasDetails ? 'pointer' : 'default',
            borderBottom: expanded && hasDetails ? '1px solid #e5e7eb' : 'none',
          }}
          onClick={() => hasDetails && this.toggle()}>
          <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
            <div style={{flexShrink: 0}}>{this.getStatusIcon(step.status)}</div>
            <span
              style={{
                fontWeight: 500,
                color: '#121212',
                wordBreak: 'break-word',
                flex: 1,
              }}>
              {step.title}
            </span>
          </div>
          {hasDetails &&
            (expanded ? (
              <ChevronDown
                size={16}
                style={{color: '#121212', flexShrink: 0}}
              />
            ) : (
              <ChevronRight
                size={16}
                style={{color: '#121212', flexShrink: 0}}
              />
            ))}
        </div>

        {expanded && hasDetails && (
          <div style={{padding: '16px'}}>
            <div style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
              {step.details.map((detail, idx) =>
                this.renderDetail(detail, idx),
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
}

export class AnalysisProcess extends React.Component<AnalysisProcessProps> {
  render() {
    const {steps} = this.props;

    return (
      <div>
        <h3
          style={{
            fontSize: '1.125rem',
            fontWeight: 600,
            color: '#111827',
            marginBottom: '16px',
          }}>
          Analysis Process
        </h3>

        <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
          {steps.map((step: AnalysisStep) => (
            <AnalysisStepItem key={step.id} step={step} />
          ))}
        </div>
      </div>
    );
  }
}
