import type { UiElement } from "./client.js";

export interface UiBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  center_x: number;
  center_y: number;
}

export interface UiElementDescriptor {
  element_id: string;
  selector: string;
  name: string;
  automation_id: string;
  control_type: string;
  class_name: string;
  bounds: UiBounds;
  enabled: boolean;
  visible: boolean;
  value: string;
  role: string;
  label: string;
  actions: string[];
  raw: UiElement;
}

export interface UiActionTarget {
  element_id: string;
  selector: string;
  name: string;
  control_type: string;
  role: string;
  label: string;
  value: string;
  actions: string[];
  bounds: UiBounds;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeControlType(controlType: string | undefined): string {
  const value = controlType ?? "";
  const marker = "ControlType.";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

function quoteSelectorValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function selectorForElement(element: UiElement): string {
  if (element.automationId) {
    return `[automationId='${quoteSelectorValue(element.automationId)}']`;
  }
  if (element.name) {
    return `[name='${quoteSelectorValue(element.name)}']`;
  }
  if (element.className) {
    return `[className='${quoteSelectorValue(element.className)}']`;
  }
  const controlType = normalizeControlType(element.controlType);
  if (controlType) {
    return `[controlType='${quoteSelectorValue(controlType)}']`;
  }
  return "";
}

function elementNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boundsForElement(element: UiElement): UiBounds {
  const legacy = element as UiElement & {
    boundingBox?: { x?: number; y?: number; width?: number; height?: number };
  };
  const x = elementNumber(element.x ?? legacy.boundingBox?.x);
  const y = elementNumber(element.y ?? legacy.boundingBox?.y);
  const width = elementNumber(element.width ?? legacy.boundingBox?.width);
  const height = elementNumber(element.height ?? legacy.boundingBox?.height);
  return {
    x,
    y,
    width,
    height,
    center_x: Math.round(x + width / 2),
    center_y: Math.round(y + height / 2),
  };
}

function roleForControlType(controlType: string): string {
  const normalized = controlType.toLowerCase();
  const roles: Record<string, string> = {
    button: "button",
    checkbox: "checkbox",
    combobox: "combobox",
    document: "document",
    edit: "textbox",
    hyperlink: "link",
    image: "img",
    list: "list",
    listitem: "listitem",
    menu: "menu",
    menuitem: "menuitem",
    pane: "region",
    radiobutton: "radio",
    tab: "tablist",
    tabitem: "tab",
    text: "text",
    tree: "tree",
    treeitem: "treeitem",
    window: "window",
  };
  return roles[normalized] ?? normalized;
}

function labelForElement(element: UiElement, controlType: string): string {
  const name = element.name?.trim();
  if (name) return name;
  const value = element.value?.trim();
  if (value) return value;
  const automationId = element.automationId?.trim();
  if (automationId) return automationId;
  const className = element.className?.trim();
  if (className) return className;
  return roleForControlType(controlType) || controlType;
}

function actionsForElement(element: UiElement, controlType: string): string[] {
  const enabled = Boolean(element.isEnabled);
  const visible = Boolean(element.isVisible);
  if (!enabled || !visible) {
    return [];
  }

  const normalized = controlType.toLowerCase();
  const actions = new Set<string>();
  if (
    [
      "button",
      "checkbox",
      "combobox",
      "hyperlink",
      "listitem",
      "menuitem",
      "radiobutton",
      "tabitem",
    ].includes(normalized)
  ) {
    actions.add("click");
  }
  if (["combobox", "document", "edit"].includes(normalized)) {
    actions.add("type");
  }
  if (["combobox", "document", "edit", "list", "listitem", "tree", "treeitem"].includes(normalized)) {
    actions.add("key");
  }
  return [...actions];
}

export function describeUiElements(elements: UiElement[]): UiElementDescriptor[] {
  return elements.map((element, index) => {
    const bounds = boundsForElement(element);
    const selector = selectorForElement(element);
    const controlType = normalizeControlType(element.controlType);
    const role = roleForControlType(controlType);
    const label = labelForElement(element, controlType);
    const identity = [
      selector,
      element.name ?? "",
      element.automationId ?? "",
      controlType,
      element.className ?? "",
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      index,
    ].join("|");
    return {
      element_id: `ui-${String(index + 1).padStart(3, "0")}-${stableHash(identity).slice(0, 8)}`,
      selector,
      name: element.name ?? "",
      automation_id: element.automationId ?? "",
      control_type: controlType,
      class_name: element.className ?? "",
      bounds,
      enabled: Boolean(element.isEnabled),
      visible: Boolean(element.isVisible),
      value: element.value ?? "",
      role,
      label,
      actions: actionsForElement(element, controlType),
      raw: element,
    };
  });
}

export function describeUiActionTargets(
  descriptors: UiElementDescriptor[],
  limit = 50,
): UiActionTarget[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  return descriptors
    .filter((element) => element.actions.length > 0 && element.selector.length > 0)
    .slice(0, boundedLimit)
    .map((element) => ({
      element_id: element.element_id,
      selector: element.selector,
      name: element.name,
      control_type: element.control_type,
      role: element.role,
      label: element.label,
      value: element.value,
      actions: element.actions,
      bounds: element.bounds,
    }));
}
