// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import m from 'mithril';
import {createRoot} from 'react-dom/client';
import {Table, Tooltip} from 'antd';
import Icon, {QuestionCircleOutlined} from '@ant-design/icons';
import {Component} from 'react';
import {lynxConfigState} from '../../lynx_features_flags/config';
import {UIDetailAttr, UIDetailState, IssuseUI} from './types';
import {LynxUI} from '../../lynx_perf/common_components/ui_tree/types';
import {constructUIDetail} from '../../lynx_perf/common_components/ui_tree/utils';
import {showModal} from '../../widgets/modal';
import {UITreeMithrilView} from '../../lynx_perf/common_components/ui_tree/mithril_ui_tree';

export class UIDetailView implements m.ClassComponent<UIDetailAttr> {
  oncreate(vnode: m.CVnodeDOM<UIDetailAttr>) {
    const root = createRoot(vnode.dom);
    root.render(<DetailViewPanel details={vnode.attrs.details} />);
  }

  onupdate(vnode: m.CVnodeDOM<UIDetailAttr>) {
    const root = createRoot(vnode.dom);
    root.render(<DetailViewPanel details={vnode.attrs.details} />);
  }

  view() {
    return m('.page');
  }
}

export class DetailViewPanel extends Component<UIDetailAttr, UIDetailState> {
  constructor(props: UIDetailAttr) {
    super(props);
    this.state = {
      showDialog: false,
      selectedUI: undefined,
    };
  }

  render() {
    const issuesUI: IssuseUI[] = [];
    this.assembleInvisibleUI(issuesUI);

    return (
      <div>
        {issuesUI.map((element, index) => (
          <div key={index} className="detail-box-container">
            <h1 className="detail-title">{element.title}</h1>
            <p className="detail-text">{element.description}</p>
            <Table
              bordered
              style={{marginTop: 20}}
              rowClassName="table-content-text"
              dataSource={element.dataSource}
              columns={element.columns}
              expandable={{
                showExpandColumn: false,
              }}
              pagination={{
                position: ['bottomLeft'],
                hideOnSinglePage: true,
              }}
            />
          </div>
        ))}
      </div>
    );
  }

  private assembleInvisibleUI(issuesUI: IssuseUI[]) {
    const {details} = this.props;
    const invisibleElements = details.filter((item) => item.invisible);
    const invisibleDataSource: LynxUI[] = [];
    for (const item of invisibleElements) {
      invisibleDataSource.push(item);
    }
    if (invisibleDataSource.length > 0) {
      issuesUI.push({
        title: 'Non-Visible UI Warning',
        description: (
          <>
            Although the UI is not visible to users, it still consumes rendering
            resources. Apply a lazy-loading mechanism to load the UI on-demand.
            {lynxConfigState.state.lynxLazyLoadingUrl && (
              <>
                For implementation guidance, see{' '}
                <a
                  href={lynxConfigState.state.lynxLazyLoadingUrl}
                  target="_blank">
                  Lazy Loading Documentation
                </a>
                .
              </>
            )}
          </>
        ),
        dataSource: invisibleDataSource,
        columns: [
          {
            title: this.renderUITitle(),
            dataIndex: 'name',
            key: 'name',
            render: this.renderUIRow(),
          },
          {
            title: (
              <div style={{display: 'flex'}} className="table-header-text">
                <div style={{marginRight: 5}}>Descendants count</div>
                <Tooltip
                  title="This metric represents the total number of nodes under a specific parent UI, including all direct children and subsequent layers of nested UIs."
                  color="#00000099">
                  <Icon component={QuestionCircleOutlined} />
                </Tooltip>
              </div>
            ),
            dataIndex: 'descendantCount',
            key: 'descendantCount',
          },
        ],
      });
    }
  }

  private renderUITitle() {
    return (
      <div style={{display: 'flex'}} className="table-header-text">
        <div style={{marginRight: 5}}>UI Name</div>
        <Tooltip
          title="Click the link below to view the UI's position within the tree."
          color="#00000099">
          <Icon component={QuestionCircleOutlined} />
        </Tooltip>
      </div>
    );
  }

  private renderUIRow() {
    return (_value: unknown, record: LynxUI) => (
      <a
        className="pf-anchor"
        onClick={() => {
          showModal({
            title: 'UI Tree',
            onClose: () => {
              this.setState({showDialog: false});
            },
            content: () =>
              m(UITreeMithrilView, {
                selectedUI: record,
                rootUI: record.root,
              }),
          });
          this.setState({showDialog: true, selectedUI: record});
        }}>
        <div>{constructUIDetail(record)}</div>
      </a>
    );
  }

  closeDialog = () => {
    this.setState({showDialog: false});
  };
}
