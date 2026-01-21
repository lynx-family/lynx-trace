// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {Tree, TreeDataNode, TreeProps, ConfigProvider} from 'antd';
import {Component, createRef, RefObject} from 'react';
import {LynxUI, UITreeViewProps, UITreeViewState} from './types';
import {constructUIDetail} from './utils';

interface UITreeDataNode extends TreeDataNode {
  key: string;
  children: UITreeDataNode[];
  parentNode?: UITreeDataNode;
  expanded?: boolean;
}

const LYNXVIEW_WIDTH = 320;

/**
 * UI Tree Visualization Component
 * 
 * Displays a hierarchical tree view of Lynx UIs with selection capabilities.
 * Uses Ant Design's Tree component with custom styling and behavior.
 */
export class UITreeView extends Component<
  UITreeViewProps,
  UITreeViewState
> {
  /**
   * Tree data structure for Ant Design Tree component
   */
  private treeData: UITreeDataNode[] ;
  private keysToUITreeDataNodeMap: Map<string, UITreeDataNode>;
  /**
   * Reference to the container div for scroll management
   */
  private containerRef: RefObject<HTMLDivElement | null>;
  constructor(props: UITreeViewProps) {
    super(props);
    this.treeData = [];
    this.keysToUITreeDataNodeMap = new Map<string, UITreeDataNode>();
    if (props.selectedUI && props.rootUI) {
      this.treeData = this.constructTreeData(
        props.rootUI,
        props.selectedUI,
      );
    }
    this.state = {
      treeHeight: window.innerHeight - 100,
      treeWidth: Math.max(320, window.innerWidth - LYNXVIEW_WIDTH - 100),
      expandedKeys: this.filterExpandedKeys(),
      selectedKeys: [props.selectedUI?.id ?? ''],
      autoExpandParent: true,
      selectedUI: props.selectedUI,
    };
    this.containerRef = createRef();
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  filterExpandedKeys = () => {
    const expandedKeys: string[] = [];
    const traverse = (node: UITreeDataNode) => {
      if (node.expanded) {
        expandedKeys.push(node.key as string);
      }
      if (node.children.length > 0) {
        node.children.forEach((child: UITreeDataNode) => {
          traverse(child);
        });
      }
    };
    if (this.treeData.length > 0) {
      traverse(this.treeData[0]);
    }
    return expandedKeys;
  };

  updateTreeSize = () => {
    this.setState({
      treeHeight: window.innerHeight - 100,
      treeWidth: Math.max(320, window.innerWidth - LYNXVIEW_WIDTH - 100),
    });
  };

  /**
   * Converts Lynx element hierarchy to TreeDataNode structure
   * @param rootElement - Root element of the tree
   * @returns Array of TreeDataNode for Ant Design Tree
   */
  constructTreeData = (
    rootUI: LynxUI,
    selectedUI: LynxUI,
  ) => {
    const constructTreeDataRecursively = (
      current: LynxUI,
      parentNode: UITreeDataNode | undefined,
    ): UITreeDataNode | undefined => {
      const currentTreeNode: UITreeDataNode = {
        title: constructUIDetail(current),
        key: current.id,
        children: [],
        parentNode,
        expanded: false,
      };
      this.keysToUITreeDataNodeMap.set(
        current.id,
        currentTreeNode,
      );

      for (let i = 0; i < current.children.length; i++) {
        const child = constructTreeDataRecursively(
          current.children[i],
          currentTreeNode,
        );
        if (child) {
          currentTreeNode.children?.push(child);
        }
      }

      // If current element is selected, traversal to root and mark all nodes as show: true
      if (current === selectedUI) {
        if (current.children.length > 0) {
          currentTreeNode.expanded = true;
        }
        let parentNode = currentTreeNode.parentNode;
        while (parentNode !== undefined) {
          parentNode.expanded = true;
          parentNode = parentNode.parentNode;
        }
      }
      return currentTreeNode;
    };

    const treeData: UITreeDataNode[] = [];
    const rootTree = constructTreeDataRecursively(rootUI, undefined);
    if (!rootTree) {
      return treeData;
    }
    treeData.push(rootTree);
    return treeData;
  };

  componentDidMount() {
    window.addEventListener('resize', this.updateTreeSize);

    const treeElement = this.containerRef.current?.querySelector(
      `.ant-tree-node-selected`,
    );
    if (treeElement) {
      treeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this.updateTreeSize);
  }

  handleKeyDown(event: React.KeyboardEvent) {
    const handlers : Record<string, (node: UITreeDataNode | undefined) => void> = {
      'w': this.moveUpSelectNode,
      'arrowup': this.moveUpSelectNode,
      'a': this.collapseCurrentNode,
      'arrowleft': this.collapseCurrentNode,
      's': this.moveDownSelectNode,
      'arrowdown': this.moveDownSelectNode,
      'd': this.expandCurrentNode,
      'arrowright': this.expandCurrentNode,
    };

    const handler = handlers[event.key.toLowerCase()];
    if (handler != null) {
      handler.call(this, this.keysToUITreeDataNodeMap.get(this.state.selectedKeys[0]));
      event.stopPropagation();
      event.preventDefault();
    }
  }

  render() {
    if (!this.props.rootUI) {
      return <div></div>;
    }

    const rootFrame = this.props.rootUI.frame || [0, 0, 0, 0];
    const scale = rootFrame[2] > 0 ? LYNXVIEW_WIDTH / rootFrame[2] : 1;
    const lynxViewWidth = LYNXVIEW_WIDTH;
    const lynxViewHeight = Math.max(0, Math.round((rootFrame[3] || 0) * scale));
    const selectedFrame = this.state.selectedUI?.frame || [0, 0, 0, 0];
    const selectedStyle = this.state.selectedUI
      ? {
          position: 'absolute' as const,
          left: (selectedFrame[0] || 0) * scale,
          top: (selectedFrame[1] || 0) * scale,
          width: Math.max(0, (selectedFrame[2] || 0) * scale),
          height: Math.max(0, (selectedFrame[3] || 0) * scale),
          background: 'rgba(173, 216, 230, 0.6)',
          border: '1px solid #6BACDE',
          boxSizing: 'border-box' as const,
        }
      : undefined;

    return (
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div
          onKeyDown={this.handleKeyDown}
          ref={this.containerRef}
          style={{
            overflow: 'auto',
            height: this.state.treeHeight,
            width: this.state.treeWidth,
            borderRadius: 6,
          }}>
          <ConfigProvider
            theme={{
              components: {
                Tree: {
                  nodeSelectedBg: '#6BACDE',
                },
              },
            }}>
            <Tree
              style={{
                fontSize: 14,
                fontFamily: 'Roboto Condensed',
                color: '#121212',
              }}
              treeData={this.treeData}
              autoExpandParent={this.state.autoExpandParent}
              expandedKeys={this.state.expandedKeys}
              defaultExpandParent={true}
              selectedKeys={this.state.selectedKeys}
              onSelect={this.onSelect}
              onExpand={this.onExpand}
            />
          </ConfigProvider>
        </div>
        <div style={{ width: lynxViewWidth, flexShrink: 0 }}>
          <div
            style={{
              position: 'relative',
              width: lynxViewWidth,
              height: lynxViewHeight,
              background: '#e5e7eb',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              overflow: 'visible',
            }}>
            {selectedStyle && <div style={selectedStyle} />}
          </div>
        </div>
      </div>
    );
  }

  /**
   * Handles tree node selection
   * @param selectedKeys - Array of selected node keys
   */
  onSelect: TreeProps['onSelect'] = (selectedKeys) => {
    if (selectedKeys.length > 0) {
      const keys = selectedKeys as string[];
      const selectKey = keys[0];
      let found: LynxUI | undefined = undefined;
      const dfs = (node: LynxUI): boolean => {
        if (node.id === selectKey) {
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
      if (this.props.rootUI) {
        dfs(this.props.rootUI);
      }
      this.setState({
        selectedKeys: keys,
        selectedUI: found,
      });
    }
  };

  /**
   * Recursively searches element tree to find and select node by ID
   * @param selectKey - ID of node to select
   * @param currentElement - Current element in traversal
   */
  onExpand: TreeProps['onExpand'] = (expandedKeys) => {
    this.setState({
      expandedKeys: expandedKeys as string[],
      autoExpandParent: false,
    });
  };

  moveUpSelectNode = (current: UITreeDataNode | undefined) => {
    if (!current || !current.parentNode) {
      return;
    }
    const parent = current.parentNode;
    if (parent.children.length > 0) {
      // find the first child node before current node.
      for (let i = 0; i < parent.children.length; i++) {
        if (parent.children[i].key === current.key) {
          if (i > 0) {
            let upNode = parent.children[i - 1];
            while (this.state.expandedKeys.includes(upNode.key)) {
              upNode = upNode.children[upNode.children.length - 1];
            }
            this.setState({selectedKeys: [upNode.key]});
            return;
          } else {
            this.setState({selectedKeys: [parent.key]});
            return;
          }
        }
      }
    }
  };

  moveDownSelectNode = (current: UITreeDataNode | undefined) => {
    if (!current) {
      return;
    }
    if (this.state.expandedKeys.includes(current.key)) {
      if (current.children.length > 0) {
        this.setState({selectedKeys: [current.children[0].key]});
        return;
      }
    }
    let parent = current.parentNode;
    while (parent) {
      for (let i = 0; i < parent.children.length; i++) {
        if (parent.children[i].key === current.key) {
          if (i < parent.children.length - 1) {
            this.setState({selectedKeys: [parent.children[i + 1].key]});
            return;
          } else {
            break;
          }
        }
      }
      current = parent;
      parent = parent.parentNode;
    }
  };

  expandCurrentNode = (current: UITreeDataNode | undefined) => {
    if (
      !current ||
      this.state.expandedKeys.includes(current.key)
    ) {
      return;
    }
    if (current.children.length <= 0) {
      return;
    }
    this.setState({expandedKeys: [...this.state.expandedKeys, current.key]});
  };

  collapseCurrentNode = (current: UITreeDataNode | undefined) => {
    if (
      !current ||
      !this.state.expandedKeys.includes(current.key)
    ) {
      return;
    }
    if (current.children.length <= 0) {
      return;
    }

    const removedExpanedKeys: string[] = [];
    const traverse = (node: UITreeDataNode) => {
      if (node.children.length > 0) {
        node.children.forEach((child: UITreeDataNode) => {
          traverse(child);
        });
        removedExpanedKeys.push(node.key);
      }
    };
    traverse(current);

    this.setState({
      expandedKeys: this.state.expandedKeys.filter(
        (key) => !removedExpanedKeys.includes(key),
      ),
    });
  };
}
