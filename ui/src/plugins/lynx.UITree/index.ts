// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Trace} from '../../public/trace';
import {PerfettoPlugin} from '../../public/plugin';
import {NUM, NUM_NULL, STR} from '../../trace_processor/query_result';
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
import {
  getFirstNumberArg,
  getFirstStringArg,
} from '../../lynx_perf/trace_utils';
import {TrackNode} from '../../public/workspace';
import {ThreadSortOrder} from '../../lynx_perf/thread_order';
import ProcessThreadGroupsPlugin from '../dev.perfetto.ProcessThreadGroups';
import {isLynxBackgroundScriptThreadGroup} from '../../lynx_perf/track_utils';
import {
  addIssueTrackAboveVitalTimestamp,
  getFirstIssueProcessGroup,
} from '../../lynx_perf/issue_track_utils';

/**
 * Lynx UI Tree Performance Analysis Plugin
 * Tracks and analyzes Lynx UI tree structures for performance issues,
 * including invisible nodes.
 */
export default class LynxUITreePlugin implements PerfettoPlugin {
  static readonly id = LYNX_UI_TREE_PLUGIN_ID;
  static readonly dependencies = [LynxPerf, ProcessThreadGroupsPlugin];
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
      renderer: new LynxUIIssueTrack(),
    });
    this.addIssueTrack(ctx, uiIssues);
  }

  /**
   * Retrieves and processes element tree data from trace
   * @param engine - Trace processor engine instance
   * @returns Array of detected performance issues
   */
  async getIssueData(engine: Engine): Promise<IssueSummary[]> {
    const queryRes = await engine.query(
      `select
        slice.ts,
        slice.id,
        slice.dur,
        slice.name,
        slice.arg_set_id as argSetId,
        thread.upid
      from slice
      left join thread_track on slice.track_id = thread_track.id
      left join thread using (utid)
      where slice.name='DumpUITreeLayout'
      order by slice.ts desc`,
    );
    const it = queryRes.iter({
      argSetId: NUM,
      ts: NUM,
      id: NUM,
      dur: NUM,
      name: STR,
      upid: NUM_NULL,
    });
    const data: IssueSummary[] = [];

    this.issueNodesMap.clear();
    for (; it.valid(); it.next()) {
      const args = await getArgs(engine, asArgSetId(it.argSetId));
      const instanceId = getFirstNumberArg(args, [
        'debug.instance_id',
        'args.instance_id',
      ]);
      if (instanceId === undefined) {
        continue;
      }
      if (!this.issueNodesMap.has(instanceId)) {
        this.issueNodesMap.set(instanceId, new Set());
      }
      const content = getFirstStringArg(args, ['debug.detail', 'args.detail']);
      if (content === '') {
        continue;
      }
      const rootUITree = stringToJsonObject(content);
      if (rootUITree === undefined) {
        continue;
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
          upid: it.upid,
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
          const children = node.children ?? [];
          for (let i = 0; i < children.length; i++) {
            if (dfs(children[i])) {
              return true;
            }
          }
          return false;
        };
        dfs(rootUITree);
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
        return data;
      }
    }
    return data;
  }

  private addIssueTrack(ctx: Trace, uiIssues: IssueSummary[]) {
    if (uiIssues.length === 0) {
      return;
    }
    const issueTrack = new TrackNode({
      uri: LYNX_UI_TREE_PLUGIN_ID,
      name: 'Lynx UI Tree Issues',
      sortOrder: ThreadSortOrder.PERFORMANCE_ISSUES,
    });
    const processGroup = this.getProcessGroupForIssues(ctx, uiIssues);
    if (processGroup !== undefined) {
      addIssueTrackAboveVitalTimestamp(processGroup, issueTrack, uiIssues);
      return;
    }
    const lynxGroup = ctx.currentWorkspace.children.find((item) =>
      isLynxBackgroundScriptThreadGroup(item),
    );
    if (lynxGroup !== undefined) {
      addIssueTrackAboveVitalTimestamp(lynxGroup, issueTrack, uiIssues);
    }
  }

  private getProcessGroupForIssues(
    ctx: Trace,
    uiIssues: IssueSummary[],
  ): TrackNode | undefined {
    const processGroups = ctx.plugins.getPlugin(ProcessThreadGroupsPlugin);
    return getFirstIssueProcessGroup(uiIssues, (upid) =>
      processGroups.getGroupForProcess(upid),
    );
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
