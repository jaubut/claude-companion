# tldraw Figma-Style Inspector & Auto-Layout Agent Build Spec
Agent Build Spec: tldraw Figma-Style Inspector & Auto-Layout System
1. Objective & Architecture Overview
Upgrade an existing tldraw + React component drag-and-drop workspace and AI chat bar with Figma-grade layout ergonomics—without losing tldraw's clean JSON state model for the AI agent.
Core Capabilities to Implement
Typed Component & Layout Schema (ui-shape-schema.ts): Shared Flexbox layout tokens (direction, justify, align, gap, paddingX, paddingY, radius, sizingW, sizingH) plus a dynamic variant registry for drag-and-drop React library components.
Custom React Component Shape (UiBlockShapeUtil.tsx): Renders real design-library components inside HTMLContainer, supports internal CSS Flexbox, and syncs DOM height back to tldraw bounds in hug mode via ResizeObserver.
Canvas Auto-Layout Parent Frame (AutoLayoutFrameUtil.tsx + reflow-engine.ts): A parent container shape (auto-layout-frame) that accepts dragged ui-block shapes (and nested frames), reparents them automatically on drag-over/drag-out, sorts children by spatial drag order, and deterministically computes child (x, y) and stretch dimensions whenever props or children change.
Reactive Figma Property Inspector (FigmaInspector.tsx): Mounted alongside <Tldraw /> via <EditorProvider>, hiding tldraw's default StylePanel. Supports multi-select "mixed" value resolution, a 3x3 alignment matrix, Shift + A ("Wrap in Auto-Layout Frame"), and single-step Cmd/Ctrl + Z undo marks.
AI Brain Bridge (agent-canvas-bridge.ts): Exposes a clean hierarchical tree serializer and declarative patch applier so the AI chat bar reads/mutates layout props and variants without manual (x, y) math.
2. Target File Structure
Create or integrate the following modules inside your canvas feature directory (e.g., src/features/canvas/):
| Module Path | Responsibilities & Scope |
| schema/ui-shape-schema.ts | Component variant registry, shared Auto-Layout types, and tldraw validators. |
| layout/reflow-engine.ts | Deterministic Flexbox layout solver and tldraw side-effect listeners for parent frames. |
| shapes/UiBlockShapeUtil.tsx | Leaf React component shape with ResizeObserver hug-contents support. |
| shapes/AutoLayoutFrameUtil.tsx | Parent container shape handling drag-in, drag-out, and frame chrome. |
| inspector/FigmaInspector.tsx | Right-hand reactive sidebar (track) + Shift + A frame wrapper action. |
| agent/agent-canvas-bridge.ts | Hierarchical JSON state reader & mutation helper for the main AI chat bar. |
| Workspace.tsx | Side-by-side shell wiring <Tldraw />, <EditorProvider>, drag-and-drop sidebar, chat bar, and keyboard shortcuts. |
3. Step-by-Step Implementation Specs
Step 1: Shared Layout & Variant Schema (schema/ui-shape-schema.ts)
Define both 'ui-block' and 'auto-layout-frame' in TLGlobalShapePropsMap so editor.updateShapes is strictly typed across the inspector and AI tools.
import { T } from 'tldraw'
export const COMPONENT_REGISTRY = {
  button: {
    label: 'Button',
    variants: {
      variant: ['default', 'secondary', 'outline', 'ghost', 'destructive'] as const,
      size: ['sm', 'md', 'lg'] as const,
    },
    defaults: { variant: 'default', size: 'md', label: 'Continue' },
  },
  card: {
    label: 'Metric Card',
    variants: {
      elevation: ['flat', 'sm', 'md'] as const,
      accent: ['none', 'top-border', 'subtle-bg'] as const,
    },
    defaults: { elevation: 'sm', accent: 'none', label: 'Total Revenue' },
  },
  input: {
    label: 'Text Input',
    variants: {
      size: ['sm', 'md', 'lg'] as const,
      state: ['default', 'error', 'disabled'] as const,
    },
    defaults: { size: 'md', state: 'default', placeholder: 'Search...' },
  },
} as const
export type ComponentKind = keyof typeof COMPONENT_REGISTRY
export interface SharedFlexProps {
  w: number
  h: number
  sizingW: 'fixed' | 'hug'
  sizingH: 'fixed' | 'hug'
  direction: 'row' | 'column'
  justify: 'flex-start' | 'center' | 'flex-end' | 'space-between'
  align: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  gap: number
  paddingX: number
  paddingY: number
  radius: number
}
export interface UiBlockProps extends SharedFlexProps {
  componentKind: ComponentKind
  variantProps: Record<string, string>
}
export interface AutoLayoutFrameProps extends SharedFlexProps {
  name: string
  bg: string
}
declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    'ui-block': UiBlockProps
    'auto-layout-frame': AutoLayoutFrameProps
  }
}
export const sharedFlexSchema = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  sizingW: T.literalEnum('fixed', 'hug'),
  sizingH: T.literalEnum('fixed', 'hug'),
  direction: T.literalEnum('row', 'column'),
  justify: T.literalEnum('flex-start', 'center', 'flex-end', 'space-between'),
  align: T.literalEnum('flex-start', 'center', 'flex-end', 'stretch'),
  gap: T.number,
  paddingX: T.number,
  paddingY: T.number,
  radius: T.number,
}
export const uiBlockPropsSchema = {
  ...sharedFlexSchema,
  componentKind: T.literalEnum('button', 'card', 'input'),
  variantProps: T.dict(T.string, T.string),
}
export const autoLayoutFramePropsSchema = {
  ...sharedFlexSchema,
  name: T.string,
  bg: T.string,
}
Step 2: Deterministic Canvas Auto-Layout Solver (layout/reflow-engine.ts)
In tldraw, child coordinates (x, y) are local to their parent shape's top-left corner (0, 0). Register side effects on the Editor instance to recompute child positions whenever a child is added, deleted, resized, or dragged, using a re-entrancy guard (isReflowing) to prevent recursive update loops.
import { Editor, IndexKey, TLShape, TLShapeId, getIndicesBetween } from 'tldraw'
type LayoutShape = TLShape<'auto-layout-frame'> | TLShape<'ui-block'>
function isAutoLayoutFrame(shape?: TLShape | null): shape is TLShape<'auto-layout-frame'> {
  return Boolean(shape && shape.type === 'auto-layout-frame')
}
function isSizableChild(shape?: TLShape | null): shape is LayoutShape {
  return Boolean(
    shape && (shape.type === 'ui-block' || shape.type === 'auto-layout-frame')
  )
}
export function reflowAutoLayoutFrame(
  editor: Editor,
  frameId: TLShapeId,
  options: { reorderByPosition?: boolean; activeDragIds?: Set<TLShapeId> } = {}
) {
  const frame = editor.getShape(frameId)
  if (!isAutoLayoutFrame(frame)) return
  const childIds = editor.getSortedChildIdsForParent(frameId)
  let children = childIds
    .map((id) => editor.getShape(id))
    .filter(isSizableChild)
  const isRow = frame.props.direction === 'row'
  const padMain = isRow ? frame.props.paddingX : frame.props.paddingY
  const padCross = isRow ? frame.props.paddingY : frame.props.paddingX
  // 1. Optional spatial sort when user drags a child to reorder stack
  if (options.reorderByPosition && children.length > 1) {
    children = [...children].sort((a, b) => {
      const centerA = isRow ? a.x + a.props.w / 2 : a.y + a.props.h / 2
      const centerB = isRow ? b.x + b.props.w / 2 : b.y + b.props.h / 2
      return centerA - centerB
    })
    const freshIndices = getIndicesBetween(undefined, undefined, children.length)
    editor.updateShapes(
      children.map((child, idx) => ({
        id: child.id,
        type: child.type,
        index: freshIndices[idx] as IndexKey,
      }))
    )
  }
  // 2. Compute main & cross dimensions
  const totalChildMain = children.reduce(
    (sum, c) => sum + (isRow ? c.props.w : c.props.h),
    0
  )
  const totalGaps = Math.max(0, children.length - 1) * frame.props.gap
  const maxChildCross = children.reduce(
    (max, c) => Math.max(max, isRow ? c.props.h : c.props.w),
    0
  )
  const nextFrameW =
    frame.props.sizingW === 'hug'
      ? Math.max(80, isRow ? padMain * 2 + totalChildMain + totalGaps : padCross * 2 + maxChildCross)
      : frame.props.w
  const nextFrameH =
    frame.props.sizingH === 'hug'
      ? Math.max(80, isRow ? padCross * 2 + maxChildCross : padMain * 2 + totalChildMain + totalGaps)
      : frame.props.h
  if (nextFrameW !== frame.props.w || nextFrameH !== frame.props.h) {
    editor.updateShape({
      id: frame.id,
      type: 'auto-layout-frame',
      props: { w: nextFrameW, h: nextFrameH },
    })
  }
  const innerMain = (isRow ? nextFrameW : nextFrameH) - padMain * 2
  const innerCross = Math.max(20, (isRow ? nextFrameH : nextFrameW) - padCross * 2)
  // 3. Starting cursor & step gap for justify-content
  let cursor = padMain
  let stepGap = frame.props.gap
  const freeSpace = Math.max(0, innerMain - (totalChildMain + totalGaps))
  if (frame.props.justify === 'center') {
    cursor = padMain + freeSpace / 2
  } else if (frame.props.justify === 'flex-end') {
    cursor = padMain + freeSpace
  } else if (frame.props.justify === 'space-between' && children.length > 1) {
    cursor = padMain
    stepGap = Math.max(0, (innerMain - totalChildMain) / (children.length - 1))
  }
  // 4. Position and optionally stretch each child
  const updates: Parameters<Editor['updateShapes']>[0] = []
  for (const child of children) {
    const shouldStretch = frame.props.align === 'stretch'
    const childW = !isRow && shouldStretch ? innerCross : child.props.w
    const childH = isRow && shouldStretch ? innerCross : child.props.h
    const childCrossSize = isRow ? childH : childW
    let crossPos = padCross
    if (frame.props.align === 'center') {
      crossPos = padCross + (innerCross - childCrossSize) / 2
    } else if (frame.props.align === 'flex-end') {
      crossPos = padCross + (innerCross - childCrossSize)
    }
    const nextX = isRow ? cursor : crossPos
    const nextY = isRow ? crossPos : cursor
    // Do not fight pointer while user actively drags this specific child; snap siblings around it
    const isActivelyDragged = options.activeDragIds?.has(child.id) ?? false
    updates.push({
      id: child.id,
      type: child.type,
      ...(isActivelyDragged ? {} : { x: nextX, y: nextY }),
      props: {
        w: childW,
        h: childH,
        ...(!isRow && shouldStretch ? { sizingW: 'fixed' as const } : {}),
        ...(isRow && shouldStretch ? { sizingH: 'fixed' as const } : {}),
      },
    })
    cursor += (isRow ? childW : childH) + stepGap
  }
  if (updates.length > 0) {
    editor.updateShapes(updates)
  }
  // Bubble up if this frame is nested inside an outer Auto-Layout frame
  const parent = editor.getShapeParent(frame)
  if (isAutoLayoutFrame(parent)) {
    reflowAutoLayoutFrame(editor, parent.id)
  }
}
export function registerAutoLayoutSideEffects(editor: Editor) {
  let isReflowing = false
  const safeRun = (fn: () => void) => {
    if (isReflowing) return
    isReflowing = true
    try {
      fn()
    } finally {
      isReflowing = false
    }
  }
  const unsubCreate = editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
    safeRun(() => {
      const parent = editor.getShapeParent(shape)
      if (isAutoLayoutFrame(parent)) {
        reflowAutoLayoutFrame(editor, parent.id)
      }
    })
  })
  const unsubChange = editor.sideEffects.registerAfterChangeHandler('shape', (prev, next) => {
    safeRun(() => {
      if (isAutoLayoutFrame(next)) {
        reflowAutoLayoutFrame(editor, next.id)
      }
      const prevParent = editor.getShape(prev.parentId as TLShapeId)
      const nextParent = editor.getShape(next.parentId as TLShapeId)
      if (isAutoLayoutFrame(prevParent) && prev.parentId !== next.parentId) {
        reflowAutoLayoutFrame(editor, prevParent.id)
      }
      if (isAutoLayoutFrame(nextParent)) {
        const isDragging = editor.inputs.isDragging
        const selectedSet = new Set(editor.getSelectedShapeIds())
        reflowAutoLayoutFrame(editor, nextParent.id, {
          reorderByPosition: isDragging && selectedSet.has(next.id),
          activeDragIds: isDragging ? selectedSet : undefined,
        })
      }
    })
  })
  const unsubDelete = editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
    safeRun(() => {
      const parent = editor.getShape(shape.parentId as TLShapeId)
      if (isAutoLayoutFrame(parent)) {
        reflowAutoLayoutFrame(editor, parent.id)
      }
    })
  })
  return () => {
    unsubCreate()
    unsubChange()
    unsubDelete()
  }
}

Pointer-up snap note: Also listen to pointer-up (or wrap a lightweight editor.on('event', (e) => { if (e.name === 'pointer_up') ... }) listener) to invoke reflowAutoLayoutFrame(editor, parent.id) with activeDragIds: undefined so the dropped shape snaps cleanly into its final calculated slot as soon as the drag ends.
Step 3: Auto-Layout Parent Frame Shape (shapes/AutoLayoutFrameUtil.tsx)
Enable canReceiveNewChildrenOfType, onDragShapesOver, and onDragShapesOut so components dragged from the canvas or palette drop directly into the Flexbox stack.
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  TLDragShapesOutInfo,
  TLResizeInfo,
  TLShape,
  resizeBox,
} from 'tldraw'
import { autoLayoutFramePropsSchema } from '../schema/ui-shape-schema'
import { reflowAutoLayoutFrame } from '../layout/reflow-engine'
export type AutoLayoutFrameShape = TLShape<'auto-layout-frame'>
export class AutoLayoutFrameUtil extends BaseBoxShapeUtil<AutoLayoutFrameShape> {
  static override type = 'auto-layout-frame' as const
  static override props = autoLayoutFramePropsSchema
  override providesBackgroundForChildren(): boolean {
    return true
  }
  override canReceiveNewChildrenOfType(_shape: AutoLayoutFrameShape, type: TLShape['type']) {
    return type === 'ui-block' || type === 'auto-layout-frame'
  }
  override getDefaultProps(): AutoLayoutFrameShape['props'] {
    return {
      name: 'Screen Frame',
      w: 390,
      h: 520,
      sizingW: 'fixed',
      sizingH: 'hug',
      direction: 'column',
      justify: 'flex-start',
      align: 'stretch',
      gap: 16,
      paddingX: 20,
      paddingY: 20,
      radius: 16,
      bg: '#ffffff',
    }
  }
  override onResize(shape: AutoLayoutFrameShape, info: TLResizeInfo<AutoLayoutFrameShape>) {
    const resized = resizeBox(shape, info)
    return {
      ...resized,
      props: {
        ...resized.props,
        // Manual resize switches axes from Hug -> Fixed just like Figma
        sizingW: 'fixed' as const,
        sizingH: 'fixed' as const,
      },
    }
  }
  override onDragShapesOver(frame: AutoLayoutFrameShape, shapes: TLShape[]) {
    const eligible = shapes.filter(
      (s) =>
        (s.type === 'ui-block' || s.type === 'auto-layout-frame') &&
        s.id !== frame.id &&
        !this.editor.hasAncestor(frame, s.id)
    )
    const toReparent = eligible.filter((s) => s.parentId !== frame.id)
    if (toReparent.length > 0) {
      this.editor.reparentShapes(toReparent, frame.id)
    }
  }
  override onDragShapesOut(
    frame: AutoLayoutFrameShape,
    shapes: TLShape[],
    info: TLDragShapesOutInfo
  ) {
    if (!info.nextDraggingOverShapeId) {
      this.editor.reparentShapes(shapes, this.editor.getCurrentPageId())
      reflowAutoLayoutFrame(this.editor, frame.id)
    }
  }
  override component(shape: AutoLayoutFrameShape) {
    const { props } = shape
    return (
      <HTMLContainer style={{ width: props.w, height: props.h }}>
        <div className="relative w-full h-full">
          {/* Figma-style Frame Header Label above top-left corner */}
          <div className="absolute -top-6 left-0 flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 select-none pointer-events-none">
            <span>{props.direction === 'row' ? '→' : '↓'}</span>
            <span>{props.name}</span>
          </div>
          <div
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: props.bg,
              borderRadius: `${props.radius}px`,
            }}
            className="border border-zinc-300/90 shadow-sm box-border"
          />
        </div>
      </HTMLContainer>
    )
  }
  override indicator(shape: AutoLayoutFrameShape) {
    return (
      <rect
        width={shape.props.w}
        height={shape.props.h}
        rx={shape.props.radius}
        ry={shape.props.radius}
      />
    )
  }
}
Step 4: Leaf React Component Shape (shapes/UiBlockShapeUtil.tsx)
Renders your real design library components inside HTMLContainer and syncs measured DOM height back to shape.props.h when sizingH === 'hug'—automatically triggering the parent AutoLayoutFrameUtil to reflow!ximport { useLayoutEffect, useRef } from 'react'import { BaseBoxShapeUtil, HTMLContainer, TLResizeInfo, TLShape, resizeBox, useEditor } from 'tldraw'import { COMPONENT_REGISTRY, uiBlockPropsSchema } from '../schema/ui-shape-schema'
export type UiBlockShape = TLShape<'ui-block'>
export class UiBlockShapeUtil extends BaseBoxShapeUtil {static override type = 'ui-block' as conststatic override props = uiBlockPropsSchema
override canCull(shape: UiBlockShape) {return shape.props.sizingH !== 'hug'}
override getDefaultProps(): UiBlockShape['props'] {return {w: 280,h: 120,sizingW: 'fixed',sizingH: 'hug',componentKind: 'card',direction: 'column',justify: 'flex-start',align: 'stretch',gap: 12,paddingX: 16,paddingY: 16,radius: 12,variantProps: { ...COMPONENT_REGISTRY.card.defaults },}}
override onResize(shape: UiBlockShape, info: TLResizeInfo) {const resized = resizeBox(shape, info)return {...resized,props: {...resized.props,sizingW: 'fixed' as const,sizingH: 'fixed' as const,},}}
override component(shape: UiBlockShape) {const editor = useEditor()const innerRef = useRef(null)const { props } = shape
useLayoutEffect(() => {
  if (props.sizingH !== 'hug' || !innerRef.current) return
  const el = innerRef.current
  const syncHeight = () => {
    const measuredH = Math.ceil(el.offsetHeight)
    if (measuredH > 0 && Math.abs(measuredH - shape.props.h) > 1) {
      editor.updateShape({
        id: shape.id,
        type: 'ui-block',
        props: { h: measuredH },
      })
    }
  }
  syncHeight()
  const ro = new ResizeObserver(syncHeight)
  ro.observe(el)
  return () => ro.disconnect()
}, [editor, shape.id, props.sizingH, shape.props.h])
return (
  <HTMLContainer style={{ width: props.w, height: props.sizingH === 'hug' ? 'auto' : props.h }}>
    <div
      ref={innerRef}
      style={{
        display: 'flex',
        flexDirection: props.direction,
        justifyContent: props.justify,
        alignItems: props.align,
        gap: `${props.gap}px`,
        padding: `${props.paddingY}px ${props.paddingX}px`,
        borderRadius: `${props.radius}px`,
        height: props.sizingH === 'fixed' ? '100%' : 'auto',
        boxSizing: 'border-box',
      }}
      className="bg-white border border-zinc-200 shadow-xs overflow-hidden select-none"
    >
      {/* Plug in your existing drag-and-drop React component library renderer here */}
      <DesignLibComponent kind={props.componentKind} variants={props.variantProps} />
    </div>
  </HTMLContainer>
)

}
override indicator(shape: UiBlockShape) {return ()}}
// Placeholder adapter: swap with your actual library componentsfunction DesignLibComponent({kind,variants,}: {kind: keyof typeof COMPONENT_REGISTRYvariants: Record<string, string>}) {return ({variants.label ?? COMPONENT_REGISTRY[kind].label}{kind})}

### Step 5: Unified Figma Inspector + "Wrap in Auto Layout (`Shift + A`)" (`inspector/FigmaInspector.tsx`)
Handles both `'auto-layout-frame'` and `'ui-block'` selections, resolves `"mixed"` multi-select states, marks clean undo history stopping points, and provides one-click `Wrap in Auto Layout`.
```tsx
import { createShapeId, Editor, track, useEditor } from 'tldraw'
import { COMPONENT_REGISTRY, SharedFlexProps } from '../schema/ui-shape-schema'
import { AutoLayoutFrameShape } from '../shapes/AutoLayoutFrameUtil'
import { UiBlockShape } from '../shapes/UiBlockShapeUtil'
import { reflowAutoLayoutFrame } from '../layout/reflow-engine'
type InspectableShape = AutoLayoutFrameShape | UiBlockShape
export function wrapSelectionInAutoLayout(editor: Editor) {
  const selected = editor
    .getSelectedShapes()
    .filter((s): s is InspectableShape => s.type === 'ui-block' || s.type === 'auto-layout-frame')
  if (selected.length === 0) return
  const bounds = editor.getSelectionPageBounds()
  if (!bounds) return
  editor.markHistoryStoppingPoint('wrap-auto-layout')
  const frameId = createShapeId()
  // Auto-detect horizontal vs vertical arrangement from current bounding spread
  const isHorizontal =
    selected.length > 1 &&
    Math.abs(selected[selected.length - 1].x - selected[0].x) >
      Math.abs(selected[selected.length - 1].y - selected[0].y)
  editor.createShape<AutoLayoutFrameShape>({
    id: frameId,
    type: 'auto-layout-frame',
    x: bounds.x - 20,
    y: bounds.y - 20,
    props: {
      name: 'Auto Layout Frame',
      w: bounds.w + 40,
      h: bounds.h + 40,
      sizingW: 'hug',
      sizingH: 'hug',
      direction: isHorizontal ? 'row' : 'column',
      justify: 'flex-start',
      align: 'stretch',
      gap: 16,
      paddingX: 20,
      paddingY: 20,
      radius: 16,
      bg: '#ffffff',
    },
  })
  // Sort by visual reading order before reparenting
  const ordered = [...selected].sort((a, b) => (isHorizontal ? a.x - b.x : a.y - b.y))
  editor.reparentShapes(ordered, frameId)
  reflowAutoLayoutFrame(editor, frameId)
  editor.select(frameId)
}
function getSharedFlexProp<K extends keyof SharedFlexProps>(
  shapes: InspectableShape[],
  key: K
): SharedFlexProps[K] | 'mixed' {
  const first = shapes[0].props[key]
  return shapes.every((s) => s.props[key] === first) ? first : 'mixed'
}
const ALIGN_MATRIX = [
  ['flex-start', 'flex-start'], ['center', 'flex-start'], ['flex-end', 'flex-start'],
  ['flex-start', 'center'],     ['center', 'center'],     ['flex-end', 'center'],
  ['flex-start', 'flex-end'],   ['center', 'flex-end'],   ['flex-end', 'flex-end'],
] as const
export const FigmaInspector = track(function FigmaInspector() {
  const editor = useEditor()
  const selected = editor
    .getSelectedShapes()
    .filter((s): s is InspectableShape => s.type === 'ui-block' || s.type === 'auto-layout-frame')
  if (selected.length === 0) {
    return (
      <aside className="w-72 border-l border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-500">
        Select a component or frame on the canvas to edit Auto Layout & variants.
      </aside>
    )
  }
  const markUndo = () => editor.markHistoryStoppingPoint('inspector-edit')
  const updateFlexProps = (patch: Partial<SharedFlexProps>, discrete = false) => {
    if (discrete) markUndo()
    editor.updateShapes(
      selected.map((s) => ({
        id: s.id,
        type: s.type,
        props: patch,
      }))
    )
  }
  const direction = getSharedFlexProp(selected, 'direction')
  const justify = getSharedFlexProp(selected, 'justify')
  const align = getSharedFlexProp(selected, 'align')
  const gap = getSharedFlexProp(selected, 'gap')
  const paddingX = getSharedFlexProp(selected, 'paddingX')
  const paddingY = getSharedFlexProp(selected, 'paddingY')
  const sizingW = getSharedFlexProp(selected, 'sizingW')
  const sizingH = getSharedFlexProp(selected, 'sizingH')
  const radius = getSharedFlexProp(selected, 'radius')
  const uiBlocks = selected.filter((s): s is UiBlockShape => s.type === 'ui-block')
  const sharedKind =
    uiBlocks.length === selected.length &&
    uiBlocks.every((b) => b.props.componentKind === uiBlocks[0].props.componentKind)
      ? uiBlocks[0].props.componentKind
      : null
  return (
    <aside className="w-72 border-l border-zinc-800 bg-zinc-950 text-zinc-200 text-xs flex flex-col divide-y divide-zinc-800 overflow-y-auto">
      {/* Quick Action: Wrap in Auto Layout */}
      <section className="p-3 flex items-center justify-between">
        <span className="font-semibold text-zinc-300">
          {selected.length === 1
            ? selected[0].type === 'auto-layout-frame'
              ? selected[0].props.name
              : COMPONENT_REGISTRY[selected[0].props.componentKind].label
            : `${selected.length} Selected`}
        </span>
        <button
          onClick={() => wrapSelectionInAutoLayout(editor)}
          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
          title="Shortcut: Shift + A"
        >
          + Auto Frame
        </button>
      </section>
      {/* Dimensions & Hug/Fixed Sizing */}
      <section className="p-3 space-y-2">
        <div className="font-medium text-zinc-400">Dimensions</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center bg-zinc-900 rounded px-2 py-1 gap-2">
            <span className="text-zinc-500">W</span>
            <input
              type="number"
              onFocus={markUndo}
              value={getSharedFlexProp(selected, 'w') === 'mixed' ? '' : selected[0].props.w}
              placeholder="Mixed"
              onChange={(e) =>
                updateFlexProps({ w: Math.max(40, Number(e.target.value)), sizingW: 'fixed' })
              }
              className="bg-transparent w-full outline-none"
            />
          </label>
          <label className="flex items-center bg-zinc-900 rounded px-2 py-1 gap-2">
            <span className="text-zinc-500">H</span>
            <input
              type="number"
              onFocus={markUndo}
              value={getSharedFlexProp(selected, 'h') === 'mixed' ? '' : selected[0].props.h}
              placeholder="Mixed"
              onChange={(e) =>
                updateFlexProps({ h: Math.max(32, Number(e.target.value)), sizingH: 'fixed' })
              }
              className="bg-transparent w-full outline-none"
            />
          </label>
          <select
            value={sizingW === 'mixed' ? '' : sizingW}
            onChange={(e) => updateFlexProps({ sizingW: e.target.value as 'fixed' | 'hug' }, true)}
            className="bg-zinc-900 rounded px-2 py-1 outline-none"
          >
            <option value="fixed">W: Fixed</option>
            <option value="hug">W: Hug</option>
          </select>
          <select
            value={sizingH === 'mixed' ? '' : sizingH}
            onChange={(e) => updateFlexProps({ sizingH: e.target.value as 'fixed' | 'hug' }, true)}
            className="bg-zinc-900 rounded px-2 py-1 outline-none"
          >
            <option value="hug">H: Hug</option>
            <option value="fixed">H: Fixed</option>
          </select>
        </div>
      </section>
      {/* Auto Layout Controls */}
      <section className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-medium text-zinc-400">Auto Layout</span>
          <div className="flex bg-zinc-900 rounded p-0.5">
            {(['row', 'column'] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => updateFlexProps({ direction: dir }, true)}
                className={`px-2 py-0.5 rounded ${
                  direction === dir ? 'bg-zinc-700 text-white' : 'text-zinc-400'
                }`}
              >
                {dir === 'row' ? '→ Row' : '↓ Col'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="grid grid-cols-3 gap-1 bg-zinc-900 p-1.5 rounded w-16 h-16">
            {ALIGN_MATRIX.map(([colAlign, rowAlign], idx) => {
              const targetJustify = direction === 'row' ? colAlign : rowAlign
              const targetAlign = direction === 'row' ? rowAlign : colAlign
              const active = justify === targetJustify && align === targetAlign
              return (
                <button
                  key={idx}
                  onClick={() =>
                    updateFlexProps({ justify: targetJustify, align: targetAlign }, true)
                  }
                  className={`rounded-sm flex items-center justify-center ${
                    active ? 'bg-blue-500 text-white' : 'hover:bg-zinc-700 text-zinc-500'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                </button>
              )
            })}
          </div>
          <div className="flex-1 space-y-1.5">
            <label className="flex items-center bg-zinc-900 rounded px-2 py-1 gap-2">
              <span className="text-zinc-500">Gap</span>
              <input
                type="number"
                onFocus={markUndo}
                value={gap === 'mixed' ? '' : gap}
                placeholder="Mixed"
                onChange={(e) => updateFlexProps({ gap: Math.max(0, Number(e.target.value)) })}
                className="bg-transparent w-full outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() =>
                  updateFlexProps(
                    { justify: justify === 'space-between' ? 'flex-start' : 'space-between' },
                    true
                  )
                }
                className={`py-1 rounded border ${
                  justify === 'space-between'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-zinc-800 text-zinc-400'
                }`}
              >
                Space Btwn
              </button>
              <button
                onClick={() =>
                  updateFlexProps(
                    { align: align === 'stretch' ? 'flex-start' : 'stretch' },
                    true
                  )
                }
                className={`py-1 rounded border ${
                  align === 'stretch'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-zinc-800 text-zinc-400'
                }`}
              >
                Stretch
              </button>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <label className="flex items-center bg-zinc-900 rounded px-2 py-1 gap-1.5">
            <span className="text-zinc-500">Px</span>
            <input
              type="number"
              onFocus={markUndo}
              value={paddingX === 'mixed' ? '' : paddingX}
              onChange={(e) => updateFlexProps({ paddingX: Math.max(0, Number(e.target.value)) })}
              className="bg-transparent w-full outline-none"
            />
          </label>
          <label className="flex items-center bg-zinc-900 rounded px-2 py-1 gap-1.5">
            <span className="text-zinc-500">Py</span>
            <input
              type="number"
              onFocus={markUndo}
              value={paddingY === 'mixed' ? '' : paddingY}
              onChange={(e) => updateFlexProps({ paddingY: Math.max(0, Number(e.target.value)) })}
              className="bg-transparent w-full outline-none"
            />
          </label>
          <label className="flex items-center bg-zinc-900 rounded px-2 py-1 gap-1.5">
            <span className="text-zinc-500">R</span>
            <input
              type="number"
              onFocus={markUndo}
              value={radius === 'mixed' ? '' : radius}
              onChange={(e) => updateFlexProps({ radius: Math.max(0, Number(e.target.value)) })}
              className="bg-transparent w-full outline-none"
            />
          </label>
        </div>
      </section>
      {/* Dynamic Component Variants */}
      {sharedKind && (
        <section className="p-3 space-y-2">
          <div className="font-medium text-zinc-400">
            {COMPONENT_REGISTRY[sharedKind].label} Variants
          </div>
          {Object.entries(COMPONENT_REGISTRY[sharedKind].variants).map(([propName, options]) => {
            const currentVal = uiBlocks[0].props.variantProps[propName] ?? ''
            return (
              <div key={propName} className="flex items-center justify-between gap-2">
                <span className="text-zinc-400 capitalize">{propName}</span>
                <select
                  value={currentVal}
                  onChange={(e) => {
                    markUndo()
                    editor.updateShapes(
                      uiBlocks.map((b) => ({
                        id: b.id,
                        type: 'ui-block',
                        props: {
                          variantProps: { ...b.props.variantProps, [propName]: e.target.value },
                        },
                      }))
                    )
                  }}
                  className="bg-zinc-900 rounded px-2 py-1 outline-none"
                >
                  {options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </section>
      )}
    </aside>
  )
})
Step 6: AI Chat Bar Bridge (agent/agent-canvas-bridge.ts)
Give the AI brain a hierarchical Flexbox representation of the board instead of raw flat tldraw records, so the LLM never wastes tokens guessing (x, y) coordinates when inserting or restyling UI blocks inside frames.
import { createShapeId, Editor, TLShapeId } from 'tldraw'
import { reflowAutoLayoutFrame } from '../layout/reflow-engine'
import { AutoLayoutFrameProps, ComponentKind, SharedFlexProps } from '../schema/ui-shape-schema'
export interface AgentNode {
  id: string
  type: 'auto-layout-frame' | 'ui-block'
  props: Record<string, unknown>
  children?: AgentNode[]
}
export function serializeCanvasForAgent(editor: Editor): AgentNode[] {
  const buildNode = (id: TLShapeId): AgentNode | null => {
    const shape = editor.getShape(id)
    if (!shape || (shape.type !== 'auto-layout-frame' && shape.type !== 'ui-block')) {
      return null
    }
    const childIds = editor.getSortedChildIdsForParent(id)
    const children = childIds.map(buildNode).filter((n): n is AgentNode => n !== null)
    return {
      id: shape.id,
      type: shape.type,
      props: shape.props as unknown as Record<string, unknown>,
      ...(children.length > 0 ? { children } : {}),
    }
  }
  const pageChildIds = editor.getSortedChildIdsForParent(editor.getCurrentPageId())
  return pageChildIds.map(buildNode).filter((n): n is AgentNode => n !== null)
}
export function appendBlockToFrame(
  editor: Editor,
  parentFrameId: TLShapeId,
  componentKind: ComponentKind,
  variantProps: Record<string, string> = {},
  layoutOverrides: Partial<SharedFlexProps> = {}
) {
  const id = createShapeId()
  editor.createShape({
    id,
    type: 'ui-block',
    parentId: parentFrameId,
    props: {
      componentKind,
      variantProps,
      ...layoutOverrides,
    },
  })
  reflowAutoLayoutFrame(editor, parentFrameId)
  return id
}
export function updateFrameLayoutFromAgent(
  editor: Editor,
  frameId: TLShapeId,
  patch: Partial<AutoLayoutFrameProps>
) {
  editor.updateShape({
    id: frameId,
    type: 'auto-layout-frame',
    props: patch,
  })
  reflowAutoLayoutFrame(editor, frameId)
}
Step 7: Workspace Shell & Shortcut Wiring (Workspace.tsx)
Mount <Tldraw /> alongside <EditorProvider>, attach the side-effect engine + pointer-up snap handler, and bind Shift + A to wrap selected blocks in an Auto-Layout frame.
import { useEffect, useState } from 'react'
import { Editor, EditorProvider, TLComponents, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { AutoLayoutFrameUtil } from './shapes/AutoLayoutFrameUtil'
import { UiBlockShapeUtil } from './shapes/UiBlockShapeUtil'
import { FigmaInspector, wrapSelectionInAutoLayout } from './inspector/FigmaInspector'
import { reflowAutoLayoutFrame, registerAutoLayoutSideEffects } from './layout/reflow-engine'
const shapeUtils = [AutoLayoutFrameUtil, UiBlockShapeUtil]
const components: TLComponents = {
  StylePanel: null,
}
export function Workspace() {
  const [editor, setEditor] = useState<Editor | null>(null)
  useEffect(() => {
    if (!editor) return
    const cleanupSideEffects = registerAutoLayoutSideEffects(editor)
    // Snap dragged children into exact calculated slot on pointer release
    const cleanupEvents = editor.on('event', (event) => {
      if (event.name === 'pointer_up') {
        for (const shape of editor.getSelectedShapes()) {
          const parent = editor.getShapeParent(shape)
          if (parent?.type === 'auto-layout-frame') {
            reflowAutoLayoutFrame(editor, parent.id)
          }
        }
      }
      if (
        event.name === 'key_down' &&
        event.shiftKey &&
        event.key.toLowerCase() === 'a' &&
        !editor.getEditingShapeId()
      ) {
        wrapSelectionInAutoLayout(editor)
      }
    })
    return () => {
      cleanupSideEffects()
      cleanupEvents()
    }
  }, [editor])
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950">
      {/* Left: Existing Drag & Drop Component Palette */}
      <div className="relative flex-1">
        <Tldraw shapeUtils={shapeUtils} components={components} onMount={setEditor} />
        {/* Bottom Floating: Existing AI Brain Chat Bar */}
      </div>
      {/* Right: Figma-Style Auto-Layout & Variant Inspector */}
      {editor && (
        <EditorProvider editor={editor}>
          <FigmaInspector />
        </EditorProvider>
      )}
    </div>
  )
}
4. Agent Implementation & Verification Checklist
Execute the build in the following order and verify each acceptance criterion before moving to the next step:
Schema & Component Adapter: Wire COMPONENT_REGISTRY and DesignLibComponent to your existing React UI component library. Confirm TypeScript compiles cleanly with TLGlobalShapePropsMap augmentation.
Leaf UiBlockShapeUtil Rendering: Drag or spawn a ui-block onto the canvas. Toggle variants (e.g., sm -> lg) and confirm ResizeObserver updates shape.props.h when sizingH === 'hug'.
Parent AutoLayoutFrameUtil & Drop Reflow: Spawn an auto-layout-frame and drag 3 ui-block shapes inside it. Verify:
Children reparent into the frame and stack cleanly using gap, paddingX, and paddingY.
Dragging the bottom card above the top card reorders the stack dynamically and snaps cleanly on pointer-up.
Dragging a card completely outside the frame reparents it back to the page and collapses the remaining stack.
Nested Auto-Layout & Shift + A: Select two side-by-side ui-block buttons, press Shift + A to wrap them in a horizontal row frame, then drag that row frame into a vertical column screen frame. Verify outer hug height expands and shrinks smoothly when inner gap or padding changes.
Undo/Redo Hygiene: Focus Gap in FigmaInspector, scrub or type multiple increments, and press Cmd/Ctrl + Z once—confirm it reverts to the pre-focus value in a single undo step.
AI Chat Bar Integration: Expose serializeCanvasForAgent, appendBlockToFrame, and updateFrameLayoutFromAgent as tools to the main brain chat bar and test a natural-language prompt such as "Add a destructive button to the bottom of Screen Frame and set the frame gap to 24px."
5. Revisions before build (Brain review, 2026-11-19)
These six changes override the steps above where they conflict.
R1. Let the browser do the layout (replaces the JS flex solver in Step 2).
Render each auto-layout-frame as a real CSS flexbox inside HTMLContainer (direction, justify, align, gap, padding, wrap later). Children render in that DOM; after layout, measure each child box (getBoundingClientRect relative to the frame, divided by the camera zoom) and write the resulting x, y, w, h back to the tldraw child shapes. reflow-engine.ts shrinks to: measure DOM -> diff -> one batched updateShapes. This keeps text wrapping, min/max, nested hug and future flex-wrap exactly equal to CSS. Keep the spatial sort on drag (reorder by drag position) and the active-drag exclusion.
R2. Undo history and transactions.
All automatic writes (ResizeObserver hug heights, reflow positions, reparenting side effects) run inside one editor.run(..., { history: 'ignore' }) per frame tick, coalesced with requestAnimationFrame, so Cmd/Ctrl+Z only steps over user intents (inspector edits, drags, Shift+A). Keep markHistoryStoppingPoint for user actions. Add a guard so a reflow never triggers a second reflow in the same tick (replace the isReflowing flag with a dirty-frame set flushed once per tick, deepest frames first, then bubble up).
R3. Spec fixes.
- justify in the UiBlock style must be justifyContent (fixed above).
- The UiBlockShapeUtil code block in Step 4 is garbled (lines merged by copy-paste): rewrite it cleanly; indicator must return a <rect> like the frame.
- Remove canCull returning false for hug blocks (causes flicker/perf issues); instead keep the measured h current so culling stays correct.
- onDragShapesOut: also restore absolute page coordinates when reparenting to the page (use editor.reparentShapes, which keeps page position) and reflow the old frame once.
R4. Real components and code export.
- COMPONENT_REGISTRY points to our real component library (the dashboard welcome tiles, note-tag chips, cards, buttons, inputs from tls-dashboard-v2), generated from the components' own prop types where possible, not a hand-written list.
- Add export: a selected frame exports to JSX + Tailwind (flex classes from the layout props, components with their variant props), copied to the clipboard or written to a file in a target repo through an agent. Borrow the element <-> code mapping approach from Onlook (Apache-2.0); prior-art scan required before writing it.
R5. Agents go through the existing board MCP.
Do not add a separate bridge. Add these tools to the Companion board MCP (POST /api/mcp/board): board_tree (serializeCanvasForAgent: hierarchical frames/blocks with layout + variant props, no x/y), board_append_block (appendBlockToFrame), board_update_layout (frame or block layout/variant patch), board_wrap (Shift+A equivalent). Each is one room transaction, validated like the existing board_write ops, and appears in presence/by like other agent edits.
R6. tldraw license.
The board runs tldraw 5.6.0. Production use of the tldraw SDK requires a commercial license key (development is free). Confirm the license cost and terms for our use (Mac Canvas, iPad, one board host) before investing further; if not acceptable, evaluate alternatives in the prior-art scan (Penpot MPL-2.0 for design, Onlook Apache-2.0 for code, Excalidraw MIT for the board).
Decisions (Jeremie, 2026-11-19): license is not a blocker for now (R6 closed). First component library: BYQ Supply. Export target: see 6.3.
6. Final plan (build-ready)
6.1 Where it lives
- Board server: claude-companion server (lib/board-schema.ts, board-records.ts, board-tools.ts, board-mcp.ts). New shapes are registered in the shared board schema so the server validates them and agents can write them.
- Canvas client: the tldraw app used by the Mac Canvas and the iPad (same build). New feature folder src/features/canvas/ with the modules from section 2 (reflow-engine.ts becomes the DOM measure + write-back of R1).
- Component library: a new canvas-lib/byq/ package next to the canvas client, generated, never hand-edited.
6.2 BYQ Supply as the first library
- Source: the BYQ Supply MCP (search_byq_components / get_byq_component for sections, search_byq_gems / get_byq_gem for micro-interactions). Each component is pulled once into canvas-lib/byq/<slug>/ as React + Tailwind (component.tsx, meta.json with name, category, props and their allowed values, default props, preview thumbnail).
- Registry: COMPONENT_REGISTRY is generated from meta.json files (script canvas-lib/byq/sync.ts), so componentKind = BYQ slug and variants = the component's real props. Re-running sync updates components without breaking existing shapes (unknown props kept, removed props flagged in the inspector).
- Palette: the left drag-and-drop palette lists BYQ categories (hero, features, pricing, testimonials, footer, gems...) with thumbnails and search; dropping a block creates a ui-block with the component defaults, hug height.
- Tailwind: the canvas client compiles the Tailwind classes used by canvas-lib so BYQ blocks render exactly as in production; design tokens (colours, fonts, radius) come from a per-board theme so a block can be previewed in a client brand.
- Scope v1: 10 to 15 BYQ sections chosen for client sites (hero, features, pricing, FAQ, CTA, footer, testimonial, logo strip, stats, contact) plus 3 gems. More are added by running sync.
6.3 Export target (decided by the Brain, 2026-11-19)
- Each frame has an exportTarget prop: { repo, dir }. Default dir inside a repo: src/components/canvas/<FrameName>/ (index.tsx + one file per child section, Tailwind classes, BYQ components imported from the project copy of canvas-lib).
- Export never writes to main: an agent writes the files on a branch canvas/<frame-slug> in that repo and opens a PR, so it goes through the normal review cascade. For Astro sites (our standard) the export also emits an .astro wrapper that renders the React sections as islands only where interactive (gems), static otherwise.
- No repo linked yet: export lands on Zettlab in ~/canvas-exports/<board-page-slug>/<FrameName>/ and is shown on the board as a file card, ready to be moved into a repo later.
- The board MCP gets board_export(frameId) which returns the generated files (agents use it), and the inspector gets an Export button (copy JSX / send to repo).
6.4 Stages and acceptance (each stage = one PR, review cascade, demo on the board)
S0 Prior-art scan (0.5 day): Onlook, Penpot, tldraw make-real / computer, Plasmic, Builder.io, Framer, Webstudio. Output: what to borrow (license-checked) for DOM measurement, element-to-code mapping and the style panel. Gate: no code before this is posted.
S1 Schema + BYQ sync (2 days): canvas-lib/byq/ with 10-15 components, generated registry, TLGlobalShapePropsMap typing, board server validation for ui-block and auto-layout-frame. Accept: typecheck clean; a BYQ hero dropped on the board renders identical to its BYQ preview (screenshot diff); server rejects invalid props.
S2 Layout engine, DOM-based (2-3 days): R1 + R2 + R3. Accept: the section 4 checklist items 2-4 pass (hug, drop into frame, reorder by drag, drag out, nested frames, Shift+A); one Cmd+Z per user action; 50 frames x 300 blocks stays above 50 fps on the Mac and iPad.
S3 Inspector (1.5 days): Figma inspector with mixed values, 3x3 matrix, hug/fixed, variants from BYQ props, tldraw StylePanel hidden for these shapes only. Accept: checklist item 5; every control maps to one prop.
S4 Agents via board MCP (1 day): board_tree, board_append_block, board_update_layout, board_wrap, board_export. Accept: the brain, from the thread, builds 'a landing page frame with a BYQ hero, features and footer, gap 24' and Jeremie sees it appear live; no x/y in any tool call.
S5 Export (2 days): JSX/Tailwind + Astro wrapper, exportTarget, branch + PR flow, ~/canvas-exports fallback. Accept: exporting the S4 frame into a scratch Astro repo builds and renders the same page (screenshot diff within tolerance).
S6 Polish (1 day): iPad touch parity (drag into frames, inspector as a sheet), sync with two clients editing, docs.
Total: about 10-12 agent days.
6.5 Out of scope for v1
Grid layout, flex-wrap, absolute children inside auto-layout, component instances/overrides (Figma-style main components), libraries other than BYQ, two-way sync from code back to the canvas.