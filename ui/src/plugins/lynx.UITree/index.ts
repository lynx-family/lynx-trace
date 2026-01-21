// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Trace} from '../../public/trace';
import {PerfettoPlugin} from '../../public/plugin';
import {NUM, STR} from '../../trace_processor/query_result';
import {findInvisibleNodesRecursively} from './utils';
import ElementManager from './ui_manager';
import {Engine} from '../../trace_processor/engine';
import {getArgs} from '../../components/sql_utils/args';
import {asArgSetId} from '../../components/sql_utils/core_types';
import {IssueRank, IssueSummary} from '../../lynx_perf/types';
import {LynxUIIssueTrack} from './element_issue_track';
import {LYNX_UI_TREE_PLUGIN_ID} from '../../lynx_perf/constants';
import LynxPerf from '../lynx.perf';
import {lynxPerfGlobals} from '../../lynx_perf/lynx_perf_globals';
import {stringToJsonObject} from '../../lynx_perf/string_utils';
import {LynxUI} from '../../lynx_perf/common_components/ui_tree/types';
import {App} from '../../public/app';
import {closeModal, showModal} from '../../widgets/modal';
import {UITreeMithrilView} from '../../lynx_perf/common_components/ui_tree/mithril_ui_tree';
import m from 'mithril';
import {reConstructUITree} from '../../lynx_perf/common_components/ui_tree/utils';

/**
 * Lynx UI Tree Performance Analysis Plugin
 * Tracks and analyzes Lynx UI tree structures for performance issues,
 * including invisible nodes.
 */
export default class LynxUITreePlugin implements PerfettoPlugin {
  static readonly id = LYNX_UI_TREE_PLUGIN_ID;
  static readonly dependencies = [LynxPerf];
  private static selectUITreeId = '';
  /**
   * Tracks problematic ui nodes by instance_id
   * Key: instance_id
   * Value: Set of problematic ui node ids
   */
  private issueNodesMap: Map<number, Set<string>>;

  static async onActivate(ctx: App) {
    const args = ctx.initialRouteArgs;
    // Parse and store ui tree ID if provided
    if (args.uiTreeId) {
      this.selectUITreeId = args.uiTreeId;
    }
  }

  constructor() {
    this.issueNodesMap = new Map();
  }

  /**
   * This hook is called as the trace is loading. At this point the trace is
   * loaded into trace processor and it's ready to process queries. This hook
   * should be used for adding tracks and commands that depend on the trace.
   *
   * It should not be used for finding tracks from other plugins as there is no
   * guarantee those tracks will have been added yet.
   */
  async onTraceLoad(ctx: Trace): Promise<void> {
    const uiIssues = await this.getIssueData(ctx.engine);
    if (uiIssues.length > 0) {
      lynxPerfGlobals.appendPerformanceIssue(uiIssues);
      ctx.commands.runCommand('lynx.PerformanceIssues#update');
    }

    ctx.tracks.registerTrack({
      uri: LYNX_UI_TREE_PLUGIN_ID,
      track: new LynxUIIssueTrack(),
      title: 'Lynx UI Tree Issues',
    });
  }

  /**
   * Retrieves and processes element tree data from trace
   * @param engine - Trace processor engine instance
   * @returns Array of detected performance issues
   */
  async getIssueData(engine: Engine): Promise<IssueSummary[]> {
    const queryRes = await engine.query(
      `select ts,id,dur,name, arg_set_id as argSetId from slice where slice.name='DumpUITreeLayout' order by ts desc`,
    );
    const it = queryRes.iter({
      argSetId: NUM,
      ts: NUM,
      id: NUM,
      dur: NUM,
      name: STR,
    });
    const data: IssueSummary[] = [];

    this.issueNodesMap.clear();
    for (; it.valid(); it.next()) {
      const args = await getArgs(engine, asArgSetId(it.argSetId));
      const instanceIdArg = args.filter(
        (item) =>
          item.key === 'debug.instance_id' || item.key === 'args.instance_id',
      );
      if (instanceIdArg.length === 0) {
        continue;
      }
      const instanceId = instanceIdArg[0].value as number;
      if (!this.issueNodesMap.has(instanceId)) {
        this.issueNodesMap.set(instanceId, new Set());
      }
      args.forEach((arg) => {
        if (arg.key === 'debug.detail' || arg.key === 'args.detail') {
          const content = arg.value as string;
          const rootUITree = stringToJsonObject(content);
          if (rootUITree === undefined) {
            return;
          }
          reConstructUITree(rootUITree, undefined);
          const issueUI = this.findIssueUI(rootUITree, instanceId);
          if (issueUI.length > 0) {
            ElementManager.setTraceIssueUI(it.id, issueUI);
            data.push({
              id: it.id,
              ts: it.ts,
              tooltip: `Performance issue detected in the UI tree, click for more details`,
              trackUri: LYNX_UI_TREE_PLUGIN_ID,
              issueRank: IssueRank.CRITICAL,
            });
          }

          // open ui tree dialog if necessary
          if (LynxUITreePlugin.selectUITreeId) {
            const selectKey = LynxUITreePlugin.selectUITreeId;
            let found: LynxUI | undefined = undefined;
            const dfs = (node: LynxUI): boolean => {
              if (String(node.id) === selectKey) {
                found = node;
                return true;
              }
              for (let i = 0; i < node.children.length; i++) {
                if (dfs(node.children[i])) {
                  return true;
                }
              }
              return false;
            };
            if (rootUITree !== undefined) {
              dfs(rootUITree);
            }
            if (found !== undefined) {
              showModal({
                title: 'UI Tree',
                onClose: () => {
                  closeModal();
                },
                content: () =>
                  m(UITreeMithrilView, {
                    selectedUI: found,
                    rootUI: rootUITree,
                  }),
              });
            }
            return;
          }
        }
      });
    }
    return data;
  }

  /**
   * Analyzes ui tree for performance issues
   * @param root - Root ui of the tree to analyze
   * @param instanceId - Unique identifier for lynxview instance
   * @returns Array of problematic ui
   */
  findIssueUI(root: LynxUI, instanceId: number): LynxUI[] {
    let invisibleNodeList = findInvisibleNodesRecursively(root, root);
    const issueNodes = this.issueNodesMap.get(instanceId) as Set<string>;
    invisibleNodeList = invisibleNodeList.filter(
      (item) => !issueNodes.has(item.id),
    );
    if (invisibleNodeList.length > 0) {
      invisibleNodeList.forEach((item) => {
        issueNodes.add(item.id);
      });
    }
    return invisibleNodeList;
  }
}
