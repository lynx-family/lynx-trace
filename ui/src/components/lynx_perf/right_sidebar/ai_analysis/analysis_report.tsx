// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Component} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import m from 'mithril';
import rehypeRaw from 'rehype-raw';
import {Card} from 'antd';
import {Router} from '../../../../core/router';
import {AppImpl} from '../../../../core/app_impl';
import {getSlice} from '../../../../components/sql_utils/slice';
import {asSliceSqlId} from '../../../../components/sql_utils/core_types';
import {stringToJsonObject} from '../../../../lynx_perf/string_utils';
import {reConstructUITree} from '../../../../lynx_perf/common_components/ui_tree/utils';
import {closeModal, showModal} from '../../../../widgets/modal';
import {UITreeMithrilView} from '../../../../lynx_perf/common_components/ui_tree/mithril_ui_tree';
import {LynxUI} from '../../../../lynx_perf/common_components/ui_tree/types';
import {getFirstStringArg} from '../../../../lynx_perf/trace_utils';

interface MarkdownChildrenProps {
  children?: React.ReactNode;
}

interface MarkdownLinkProps extends MarkdownChildrenProps {
  href?: string;
}

interface AnalysisReportProps {
  analysisResult: string;
  extraActionArea?: React.ReactNode;
  status?: string;
}

export const showUITree = async (
  sliceId: string | null,
  uiTreeId: string | null,
) => {
  if (!sliceId) {
    return;
  }
  const engine = AppImpl.instance.trace?.engine;
  if (!engine) {
    return;
  }
  const slice = await getSlice(engine, asSliceSqlId(parseInt(sliceId)));
  if (!slice) {
    return;
  }
  // show ui tree dialog
  const content = getFirstStringArg(slice.args, [
    'debug.detail',
    'args.detail',
  ]);
  if (content) {
    const rootUITree = stringToJsonObject(content);
    if (rootUITree === undefined) {
      return;
    }
    const dfs = (ui: LynxUI): LynxUI | undefined => {
      if (ui.id.toString() === uiTreeId) {
        return ui;
      }
      if (ui.children) {
        for (let i = 0; i < ui.children.length; i++) {
          const r = dfs(ui.children[i]);
          if (r) {
            return r;
          }
        }
        return undefined;
      }
      return undefined;
    };

    reConstructUITree(rootUITree, undefined);
    const found = uiTreeId ? dfs(rootUITree) : rootUITree;
    if (!found) {
      return;
    }
    showModal({
      title: 'UI Tree',
      onClose: () => {
        closeModal();
      },
      content: () =>
        m(UITreeMithrilView, {
          selectedUI: found,
          rootUI: rootUITree as LynxUI,
        }),
    });
  }
};

export class AnalysisReportComponent extends Component<AnalysisReportProps> {
  private markdownClick: (e: MouseEvent) => void;
  private isEventListenerAdded = false;

  constructor(props: AnalysisReportProps) {
    super(props);
    this.markdownClick = this.handleMarkdownClick.bind(this);
  }

  private handleMarkdownClick = async (e: MouseEvent) => {
    if (
      e.target &&
      e.target instanceof HTMLElement &&
      e.target.tagName === 'A'
    ) {
      const href = e.target.getAttribute('href');

      if (href) {
        const sliceId = this.getSliceIdFromUrl(href);
        if (sliceId) {
          e.preventDefault();
          AppImpl.instance.trace?.selection.selectSqlEvent(
            'slice',
            parseInt(sliceId),
            {
              scrollToSelection: true,
            },
          );
        }
        const uiTreeId = this.getUITreeIdFromUrl(href);
        await showUITree(sliceId, uiTreeId);
      }
    }
  };

  private getSliceIdFromUrl = (href: string) => {
    try {
      const router = Router.parseUrl(href);
      return router.args.sliceId ?? null;
    } catch (error) {
      return null;
    }
  };

  private getUITreeIdFromUrl = (href: string) => {
    try {
      const router = Router.parseUrl(href);
      return router.args.uiTreeId ?? null;
    } catch (error) {
      return null;
    }
  };

  componentDidUpdate(prevProps: AnalysisReportProps, _prevState: {}) {
    if (prevProps.status === 'completed' && !this.isEventListenerAdded) {
      addEventListener('click', this.markdownClick);
      this.isEventListenerAdded = true;
      console.log('Markdown click event listener added');
    }

    // Remove event listener when status changes from completed to other states
    if (prevProps.status !== 'completed' && this.isEventListenerAdded) {
      this.removeMarkdownClickListener();
    }
  }

  private removeMarkdownClickListener() {
    if (this.isEventListenerAdded) {
      removeEventListener('click', this.markdownClick);
      this.isEventListenerAdded = false;
      console.log('Markdown click event listener removed');
    }
  }

  componentWillUnmount() {
    this.removeMarkdownClickListener();
  }

  render() {
    const {analysisResult, extraActionArea} = this.props;

    return (
      <div style={{marginBottom: '24px', flex: 1}}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
          }}>
          <h3
            style={{
              fontSize: '18px',
              fontWeight: '600',
              color: '#262626',
              margin: 0,
            }}>
            Analysis Report
          </h3>
          {extraActionArea}
        </div>

        <Card
          bodyStyle={{
            padding: '16px',
          }}>
          <div
            style={{
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              maxWidth: '100%',
            }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={{
                h2: ({children}: MarkdownChildrenProps) => (
                  <h2
                    style={{
                      color: '#000000',
                      fontSize: '18px',
                      fontWeight: '700',
                      marginBottom: '12px',
                    }}>
                    {children}
                  </h2>
                ),
                h3: ({children}: MarkdownChildrenProps) => (
                  <h3
                    style={{
                      color: '#000000',
                      fontSize: '16px',
                      fontWeight: '600',
                      marginBottom: '8px',
                    }}>
                    {children}
                  </h3>
                ),
                a: ({href, children}: MarkdownLinkProps) => {
                  const hasSliceId =
                    href !== undefined && this.getSliceIdFromUrl(href) !== null;
                  return (
                    <a
                      href={href}
                      style={{color: '#1890ff', textDecoration: 'underline'}}
                      target={hasSliceId ? undefined : '_blank'}
                      rel={hasSliceId ? undefined : 'noopener noreferrer'}>
                      {children}
                    </a>
                  );
                },
              }}>
              {analysisResult}
            </ReactMarkdown>
          </div>
        </Card>
      </div>
    );
  }
}

export default AnalysisReportComponent;
