// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export const eventDescriptionList = [
  {
    name: 'RV Prefetch',
    description: 'Android RecyclerView is attempting to pre-populate off screen views.',
  },
  {
    name: 'RV OnBindView',
    description:
      'Android RecyclerView is rebinding a View. If this is taking a lot of time, consider optimizing your layout or make sure you are not doing extra operations in onBindViewHolder call.',
  },
  {
    name: 'RV OnLayout',
    description:
      'Android RecyclerView.OnLayout has been called by the View system. If this shows up too many times in Systrace, make sure the children of RecyclerView do not update themselves directly. This will cause a full re-layout, but when it happens via the Adapter notifyItemChanged, RecyclerView can avoid full layout calculation.',
  },
  {
    name: '/^Choreographer#doFrame/',
    description:
      'Core logic of render on Android system mainly involves the following tasks: 1. Calculating dropped frames; 2. Recording frame rendering information; 3. Sequentially executing input, animation, animation insets, traversal and commit callbacks.',
  },
  {
    name: 'traversal',
    description:
      'Execute traversal callbacks. Handles layout and draw.  Runs after all other asynchronous messages have been handled.',
  },
  {
    name: 'animation',
    description: 'Execute animation callbacks.',
  },
  {
    name: 'layout',
    description:
      'Core logic of layout on Android system: Call the layout method of the root view to update the layout information of the rendering tree.',
  },
  {
    name: 'draw',
    description:
      'Core logic of draw onAndroid system: Call the draw method of the root view, recursively render the entire view hierarchy, and finally submit the rendering results to the hardware renderer.',
  },
  {
    name: 'meature',
    description:
      'Core logic of measure on Android system: Call the measure method of the root view, which will recursively call the measure method of its child views layer by layer.',
  },
  {
    name: '/^LynxRuntime::Invoke/',
    description: "Invoke task on background scripting thread(historically known as 'JS Thread').",
  },
  {
    name: '/^LynxEngine::Invoke/',
    description: "Invoke task on Engine Thread(historically known as 'Tasm Thread').",
  },
  {
    name: '/^LynxLayout::Invoke/',
    description: 'Invoke task on Layout Thread.',
  },
  {
    name: 'LynxRuntime::AfterInvoked',
    description: 'Perform some common minor tasks after completing the main task.',
  },
  {
    name: 'LynxEngine::AfterInvoked',
    description: 'Perform some common minor tasks after completing the main task.',
  },
  {
    name: 'LynxLayout::AfterInvoked',
    description: 'Perform some common minor tasks after completing the main task.',
  },
  {
    name: 'MessageLoop::FlushTasks',
    description:
      'MessageLoop is used to manage thread tasks. FlushTasks retrieves one or more tasks from the thread task queue and executes them until the task queue is empty or the maximum restriction duration is reached.',
  },
  {
    name: 'LynxEngine::LoadTemplate',
    description: 'Load the Lynx bundle.',
    historyName: '',
  },
  {
    name: 'LynxEngine::LoadTemplateBundle',
    description:
      'Load the Lynx bundle with templateBundle. Reference: @link{https://lynxjs.org/api/lynx-native-api/template-bundle.html}',
    historyName: '',
  },
  {
    name: 'LynxLoadTemplate',
    description:
      "Load the Lynx bundle, which includes three parts: parse, framework rendering, and pixel pipeline. 1. Parse: parse bundle for subsequent pipeline process; 2. Framework rendering: create and synchronize its internal representation of the UI with the actual element tree in the engine through element manipulation. @link{https://lynxjs.org/guide/spec.html#frameworkrendering-framework-rendering}; 3. Pixel pipeline: processes element tree into pixels that are displayed on the users' screen. @link{https://lynxjs.org/guide/spec.html#enginepixeling-pixel-pipeline};",
    historyName: '',
  },
  {
    name: 'FiberElement::FlushActions',
    description: 'Resolve @args{tagName} element attribute like properties, event',
  },
  {
    name: 'App::loadScript',
    description: 'Load, parse, and execute @args{url}.',
    historyName: '',
  },
  {
    name: 'App::prepareAndEvalScript',
    description: 'Load and parse the background script.',
    historyName: '',
  },
  {
    name: 'LoadJSApp',
    description: 'Load, parse and execute background scripts @args{url}.',
    historyName: '',
  },
  {
    name: 'RunningInJS',
    description: 'Execute @args{name} on background scripting thread(historically known as "JS Thread").',
    historyName: '',
  },
  {
    name: 'CallJSFunction',
    description:
      'Execute the @args{module_name}.@args{method} method on the background scripting thread (historically known as "JS Thread").',
    historyName: '',
  },
  {
    name: 'CallJSClosureEvent',
    description:
      'Execute the callbacks for the @args{type} event on background scripting thread (historically known as "JS Thread").',
    historyName: '',
  },
  {
    name: 'QuickContext::GetAndCall',
    description: "Get and call the main script's global function: @args{name}.",
    historyName: '',
  },
  {
    name: 'QuickContext::Call',
    description:
      'Call main thread script @args{name} function on Engine thread (historically known as "Tasm Thread").Some main thread script function explains: - processData: handle data; - renderPage: construct element tree; - updatePage: update element tree',
    historyName: '',
  },
  {
    name: 'FiberCreateWrapperElement',
    description:
      'Create a <wrapper/> element, a special element provided by the FiberElement API designed to serve as a low-cost container.',
    historyName: '',
  },
  {
    name: 'UpdateComponentData',
    description:
      'Update component Data. Component name is @args{componentName}. Updated Keys is @args{Keys}. `Keys` represent the state keys updated in this update.',
    historyName: '',
  },
  {
    name: 'UpdateComponentInfo',
    description: "Update the component's info, such as path, id, and the compiled render function.",
    historyName: '',
  },
  {
    name: 'LynxUpdateDataByJS',
    description: 'RootComponent update triggered by background scripting thread(historically known as "JS Thread").',
    historyName: '',
  },
  {
    name: 'LynxBatchedUpdateData',
    description: 'Batch update for component on Engine Thread(historically known as "Tasm Thread").',
    historyName: '',
  },
  {
    name: 'LynxUpdateData',
    description:
      'Root Component update. Updated Keys is @args{Keys}. Keys represent the keys of the state that were updated in this update. defaultData represents the current state keys of the root component.',
    historyName: '',
  },
  {
    name: 'LynxUpdateComponentDataByJS',
    description:
      'Component update triggered by background scripting thread (historically known as "JS Thread"). A component update can be triggered for multiple reasons.',
    historyName: '',
  },
  {
    name: 'DispatchChildrenForDiff',
    description:
      'Update the attributes of the RadonNode and recursively execute DispatchChildrenForDiff process of its child.',
    historyName: '',
  },
  {
    name: 'RadonComponent::UpdateRadonComponent',
    description: 'Update the data of the @args{componentName} component.',
    historyName: '',
  },
  {
    name: 'CreateVirtualComponent',
    description:
      'Create virtual Component on Engine thread (historically known as "TASM Thread"). Component\'s name is @args{componentName}. One or more components form a virtual node tree, which is used for subsequent render and dispatch processes.',
    historyName: '',
  },
  {
    name: 'RadonComponent::DispatchForDiff',
    description:
      'Create child nodes and update component attributes, then execute DispatchForDiff process for child nodes. Finally, send the "__OnReactComponentDidUpdate" to trigger the component\'s componentDidUpdate lifecycle method.',
    historyName: '',
  },
  {
    name: 'RadonBase::RadonMyersDiff',
    description: 'Diff process of the virtual node tree in Lynx using the MyersDiff algorithm.',
    historyName: '',
  },
  {
    name: 'RadonDispatchSelf',
    description: 'Create element and update attributes of the node if needed.',
    historyName: '',
  },
  {
    name: 'ElementManager::OnPatchFinishNoPatch',
    description: 'No changes happened in the update pipeline; it is considered a useless update.',
    historyName: '',
  },
  {
    name: 'ElementManager::OnPatchFinish',
    description:
      'Execute tasks such as the layout of elements and the creation of platform UI views after the virtual nodes diff process is completed.',
    historyName: '',
  },
  {
    name: 'LynxUIOperationQueue::ExecuteOperation',
    description: 'Execute the platform ui operations, such as creating, inserting, updating, and deleting platform ui.',
    historyName: '',
  },
  {
    name: 'LynxUIOperationQueue::Flush',
    description: 'Synchronously execute UI operations, such as creating platform ui.',
    historyName: 'LynxUIOperationQueue.Flush',
  },
  {
    name: 'LynxUIOperationAsyncQueue::FlushInterval',
    description: 'Execute UI operations, such as creating platform ui.',
    historyName: '',
  },
  {
    name: 'LayoutContext::Layout',
    description:
      'Layout stage. This stage is based on layout node tree to complete the layout stage, and finally synchronize the layout results to element. Element adjusts the layout results and generates UI layout op.',
    historyName: 'LayoutContext.Layout',
  },
  {
    name: 'LayoutContext::RequestLayout',
    description:
      'Request to trigger the Layout stage when layout related computed styles, such as width, height, are updated.',
    historyName: 'LayoutContext.RequestLayout',
  },
  {
    name: 'InvokeNativeModule',
    description:
      'Invoke the NativeModule method with module name @args{module}, method name @args(method} and first_args @args{first_arg}.',
    historyName: 'CallJSB',
  },
  {
    name: 'NativeModule::Invoke',
    description:
      'Call the NativeModule method by using the `module_name` for the module and `method_name` for the method. The arguments start from `arg0` as the first parameter, `arg1` as the second, and so on. For example, if `arg0` is `x.request` or `fetch`, it means a network request, and `arg1` contains the request parameters. The completion time of this NativeModule call corresponds to the end of the execution of the respective NativeModule::Callback, which is linked to NativeModule::Callback through the same flowId or terminateFlowId. ',
  },
  {
    name: 'Timing::OnPipelineStart',
    description:
      'Start a pipeline. Pipeline trigger is @args{pipeline_args}. About Lynx pipeline: @link{https://lynxjs.org/api/lynx-api/performance-api/performance-entry/pipeline-entry.html}',
    historyName: '',
  },
  {
    name: 'EventTracker::Flush',
    description:
      'Send reporting tasks, such as Timing reports and LongTask detection reports, to the asynchronous thread.',
    historyName: '',
  },
  {
    name: 'FlushContentSizeAndOffsetToPlatform',
    description: 'Update content size and offset and flush content size and scroll info to platform ListContainerView.',
    historyName: '',
  },
  {
    name: 'LinearLayoutManager::PreloadToStart',
    description: 'Prerender of off-screen upper elements in the <list> component.',
    historyName: '',
  },
  {
    name: 'LinearLayoutManager::Preload',
    description: 'Pre-render off-screen list child components for c++ list.',
    historyName: 'Preload',
  },
  {
    name: 'RadonDiffListNode2::ComponentAtIndex',
    description: 'Render one list child component in ReactLynx2 or TTMLRadonDiff.',
    historyName: 'RadonList::RenderComponent',
  },
  {
    name: 'ListElement::ComponentAtIndex',
    description: 'Render one list child component in ReactLynx3 or TTMLNoDiff.',
    historyName: '',
  },
  {
    name: 'ListAdapter::UpdateDataSource',
    description: 'Parse diff result and list child component info in ReactLynx2 or TTMLRadonDiff for c++ list.',
    historyName: '',
  },
  {
    name: 'ListAdapter::UpdateFiberDataSource',
    description: 'Parse diff result and list child component info in ReactLynx3 or TTMLNoDiff for c++ list.',
    historyName: '',
  },
  {
    name: 'LazyBundle::RequireTemplateEntry',
    description:
      'Send a request of LazyBundle on MTS. It is a necessary step to render a LazyBundle. However, it only occurs when rendering LazyBundle on IFR in RL3. @link{https://lynxjs.org/guide/interaction/ifr.html}',
    historyName: '',
  },
  {
    name: 'App::QueryComponent',
    description: 'Send a request of LazyBundle on BTS. It only occurs when rendering LazyBundle on RL3.',
    historyName: '',
  },
  {
    name: 'LynxUI.measure',
    description: 'The LynxUI measure process for <@args{#tag}> element.',
    historyName: '',
  },
  {
    name: 'UIOwner.createUI',
    description: 'Synchronously create platform ui for <@args{#tag}> element.',
    historyName: 'UIOwner.createView',
  },
  {
    name: 'UIOwner.createUIAsync',
    description: 'Asynchronously create platform ui for <@args{#tag}> element.',
    historyName: 'UIOwner.createViewAsync',
  },
  {
    name: 'LynxTemplateRender.draw',
    description: 'Draw LynxView and its children on Android.',
    historyName: 'LynxTemplateRender.Draw',
  },
  {
    name: 'LynxTemplateRender.layout',
    description: 'Layout LynxView and its children on Android.',
    historyName: 'LynxTemplateRender.Layout',
  },
  {
    name: 'LynxTemplateRender.measure',
    description:
      'Measure LynxView and its children on Android, which may trigger starlight re-layout if MeasureSpec changes.',
    historyName: 'LynxTemplateRender.Measure',
  },
  {
    name: 'UIOwner.invokeUIMethodForSelectorQuery',
    description:
      'Execute the UI method @args{method} of <@args{#tag}> element, triggered by NodesRef:invoke(). Reference: @link{https://lynxjs.org/api/lynx-api/nodes-ref/nodes-ref-invoke.html}',
    historyName: '',
  },
  {
    name: 'TextShadowNode.measure',
    description:
      "Layout of <text> element's platform layout node, where the element's characters are @args{characters} or the first 50 characters are @args{first_fifty_characters}.",
    historyName: '',
  },
  {
    name: 'Interceptor.shouldRedirectImageUrl',
    description:
      'Redirect the image URL. @link{https://lynxjs.org/api/css/properties/background-image.html#related-properties-of-view}',
    historyName: '',
  },
  {
    name: '[UIOwner invokeUIMethodForSelectorQuery]',
    description: 'Execute the UI method @args{method} of <@args{#tag}> element, triggered by NodesRef:invoke().',
    historyName: '',
  },
  {
    name: '[LynxUIExposure exposureHandler]',
    description:
      'Check the exposure and disexposure states of LynxUIs  and send disexposure and exposure events to trigger custom exposure listeners. link: @link{https://lynxjs.org/guide/interaction/visibility-detection/exposure-ability.html}',
    historyName: '',
  },
  {
    name: '[TextShadowNode measure]',
    description:
      "Layout of <text> element's platform layout node, where the element's characters are @args{characters} or the first 50 characters are @args{first_fifty_characters}. ",
    historyName: 'text.TextShadowNode.measure',
  },
  {
    name: 'Timing::Mark.paintEnd',
    description:
      'Mark the end of the platform layer UI drawing and wait for the UI elements to appear on the screen. The `timing_flags` field indicates different drawing stages of the page. `Lynx FCP` means the First Contentful Paint (the first frame has been drawn);`react_lynx_hydrate` shows that data synchronization between the background thread and main thread is complete; `__lynx_timing_actual_fmp` represents the actual First Meaningful Paint completion. Other values are custom business metrics, used to track various rendering stages, like the first and second render passes.',
  },
  {
    name: 'TemplateAssembler::CallLepusMethod',
    description:
      "The pipeline update runs on the main thread. When the `methodName` is something like `rLynxChange`, it means the element tree needs to be changed to update the UI. If the `methodName` is like `rLynxNoop`, it means there's no UI update needed. It is linked to the trigger source in the background thread through the `flowId`.",
  },
  {
    name: 'JsTaskAdapter::SetTimeout',
    description:
      'The JS virtual machine starts executing a new `setTimeout` macro task, it connects this task to its original `setTimeout` trigger using the `flowId` parameter.',
  },
  {
    name: 'BackgroundThread::SetTimeout',
    description:
      'When an asynchronous task is initiated, the `delay` parameter represents the delay time. If the value is 0, in most cases it means the task is executed as an awaited Promise. In Lynx Engine, many tasks could trigger asynchronous task, like setTimeout, setState, promise and component render callbacks etc.',
  },
  {
    name: 'callLepusMethod',
    description: 'After the background thread finishes the diff, it notifies engine thread to update ui.',
  },
  {
    name: 'NativeModule::PlatformCallbackStart',
    description:
      'The host platform completes the job and then calls the Lynx SDK callback. Be aware of the thread for this trace event, as its execution might be delayed by the running thread.',
  },
  {
    name: 'NativeModule::Callback',
    description:
      "When the host platform finishes and returns the response data, call the NativeModule's callback. This callback is connected to the original trigger using the `flowId` parameter. Note that the callback might be delayed if the background thread is still busy with a previous task.",
  },
  {
    name: 'JSTask::CallJSCallback',
    description:
      "When the host platform finishes and returns the response data, call the NativeModule's callback. This callback is connected to the original trigger using the `flowId` parameter. Note that the callback might be delayed if the background thread is still busy with a previous task.",
  },
  {
    name: 'PubValueToJSValue',
    description:
      'pub::Value is an abstract value interface that encapsulates an implementation around a data backend, providing a unified way to access and manipulate data. This trace event is used to track the conversion of a pub::Value instance into a JavaScript type object. The conversion process is typically required for interoperability between C++ and JS layers, ensuring type safety and data consistency. This trace can be useful for debugging cross-platform data flows, identifying type conversion issues, and performance analysis.',
  },
  {
    name: 'CallJSApiCallbackWithValue',
    description: 'When finish updating the UI on main thread, it will trigger a callback to Background thread.',
  },
  {
    name: 'VMExecute',
    description: 'Execute Main Thread Script(MTS)',
  },
  {
    name: 'PageElement::FlushActionsAsRoot',
    description: 'Recursively resolve the attributes of the element tree',
  },
  {
    name: 'TemplateAssembler::OnJSPrepared',
    description:
      'Trigger after background thread script prepared and notify background thread parsing and executing background thread script',
  },
  {
    name: 'LynxDomReady',
    description:
      'which includes 4 parts: 1. construct element tree; 2. resolve element attributes; 3. layout node tree layout; 4. create platform ui',
  },
  {
    name: 'ElementManager::OnPatchFinishInnerForFiber',
    description:
      'which includes 3 parts: 1. resolve element attributes; 2. layout node tree layout; 3. create platform ui',
  },
  {
    name: 'ElementManager::RequestLayout',
    description: 'which includes 2 parts: 1. layout node tree layout; 2. create platform ui',
  },
  {
    name: 'FiberFlushElementTree',
    description:
      'which includes 3 parts: 1. resolve element attributes; 2. layout node tree layout; 3. create platform ui',
  },
  {
    name: 'Client.onLoadSuccess',
    description: 'Lynx bundle load success lifecycle callback triggered after bundle loading success',
  },
  {
    name: 'LayoutContext.Layout',
    description:
      'Layout stage. This stage is based on layout node tree to complete the layout stage, and finally synchronize the layout results to element. Element adjusts the layout results and generates UI layout op.',
    historyName: '',
  },
  {
    name: 'LayoutContext.RequestLayout',
    description:
      'Request to trigger the Layout stage when layout related computed styles, such as width, height, are updated.',
    historyName: '',
  },
  {
    name: 'FiberElement::Constructor',
    description:
      'At this stage, based on the attribute of the element, the computed style and prop bundle of the element are generated and synchronized to the layout node. This stage will also create and modify layout node tree. At the same time, it will also generate platform UI operations.',
    historyName: '',
  },
  {
    name: 'TimingMediator::TriggerSetupClientCallback',
    description: 'The setup phase callback of timing-api for native developer',
    historyName: '',
  },
  {
    name: 'LynxUIOperationQueue.Flush',
    description: 'Synchronously execute UI operations, such as creating platform ui.',
    historyName: '',
  },
  {
    name: 'LynxView.onMeasure',
    description: "LynxView's onMeasure function, it is triggered by the Android system.",
    historyName: '',
  },
  {
    name: 'LynxView.onLayout',
    description: "LynxView's onLayout function, it is triggered by the Android system.",
    historyName: '',
  },
  {
    name: 'LynxView.onDraw',
    description: "LynxView's onDraw function, it is triggered by the Android system.",
    historyName: '',
  },
  {
    name: 'LynxView.onAttachedToWindow',
    description: "LynxView's onAttachedToWindow function, it is triggered by the Android system.",
    historyName: '',
  },
  {
    name: 'LynxView.onDetachedFromWindow',
    description: "LynxView's onDetachedFromWindow function, it is triggered by the Android system.",
    historyName: '',
  },
  {
    name: 'LynxView.updateViewport',
    description: "Update LynxView's viewport.",
    historyName: '',
  },
  {
    name: 'LynxUIExposure.exposureHandler',
    description:
      'Check the exposure and disexposure states of LynxUIs and send disexposure and exposure events to trigger custom exposure listeners. link: @link{https://lynxjs.org/guide/interaction/visibility-detection/exposure-ability.html}',
    historyName: '',
  },
];
