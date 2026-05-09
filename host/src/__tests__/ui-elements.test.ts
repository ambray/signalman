import { describe, expect, it } from "vitest";

import {
  describeUiActionTargets,
  describeUiBrowserTargets,
  describeUiElements,
} from "../guest/ui-elements.js";
import type { UiElement } from "../guest/client.js";

describe("UI element descriptors", () => {
  it("adds stable IDs, selectors, normalized bounds, and raw element data", () => {
    const elements: UiElement[] = [
      {
        name: "Save",
        automationId: "SaveButton",
        controlType: "ControlType.Button",
        className: "Button",
        isEnabled: true,
        isVisible: true,
        x: 10,
        y: 20,
        width: 90,
        height: 30,
        value: "",
      },
    ];

    const first = describeUiElements(elements);
    const second = describeUiElements(elements);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      element_id: expect.stringMatching(/^ui-001-[0-9a-f]{8}$/),
      selector: "[automationId='SaveButton']",
      name: "Save",
      automation_id: "SaveButton",
      control_type: "Button",
      class_name: "Button",
      bounds: {
        x: 10,
        y: 20,
        width: 90,
        height: 30,
        center_x: 55,
        center_y: 35,
      },
      enabled: true,
      visible: true,
      value: "",
      role: "button",
      label: "Save",
      actions: ["click"],
      raw: elements[0],
    });
  });

  it("falls back to name, class, and control type selectors", () => {
    const descriptors = describeUiElements([
      {
        name: "Don't Save",
        automationId: "",
        controlType: "ControlType.Button",
        className: "Button",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        value: "",
      },
      {
        name: "",
        automationId: "",
        controlType: "ControlType.Edit",
        className: "TextBox",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        value: "",
      },
      {
        name: "",
        automationId: "",
        controlType: "ControlType.Window",
        className: "",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        value: "",
      },
    ]);

    expect(descriptors.map((element) => element.selector)).toEqual([
      "[name='Don\\'t Save']",
      "[className='TextBox']",
      "[controlType='Window']",
    ]);
  });

  it("adds conservative action hints for LLM UI observation loops", () => {
    const descriptors = describeUiElements([
      {
        name: "Search",
        automationId: "",
        controlType: "ControlType.Edit",
        className: "Edit",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        value: "",
      },
      {
        name: "Disabled",
        automationId: "",
        controlType: "ControlType.Button",
        className: "Button",
        isEnabled: false,
        isVisible: true,
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        value: "",
      },
      {
        name: "Results",
        automationId: "",
        controlType: "ControlType.List",
        className: "ListBox",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        value: "",
      },
    ]);

    expect(descriptors.map((element) => element.actions)).toEqual([
      ["type", "key"],
      [],
      ["key"],
    ]);
  });

  it("adds browser-friendly roles and fallback labels", () => {
    const descriptors = describeUiElements([
      {
        name: "Docs",
        automationId: "",
        controlType: "ControlType.Hyperlink",
        className: "",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 0,
        width: 80,
        height: 24,
        value: "",
      },
      {
        name: "",
        automationId: "",
        controlType: "ControlType.Edit",
        className: "TextBox",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 30,
        width: 120,
        height: 24,
        value: "query",
      },
      {
        name: "",
        automationId: "submit",
        controlType: "ControlType.Button",
        className: "Button",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 60,
        width: 80,
        height: 24,
        value: "",
      },
    ]);

    expect(descriptors.map((element) => ({ role: element.role, label: element.label }))).toEqual([
      { role: "link", label: "Docs" },
      { role: "textbox", label: "query" },
      { role: "button", label: "submit" },
    ]);
  });

  it("summarizes actionable elements for LLM observation loops", () => {
    const descriptors = describeUiElements([
      {
        name: "Save",
        automationId: "SaveButton",
        controlType: "ControlType.Button",
        className: "Button",
        isEnabled: true,
        isVisible: true,
        x: 10,
        y: 20,
        width: 80,
        height: 24,
        value: "",
      },
      {
        name: "Disabled",
        automationId: "DisabledButton",
        controlType: "ControlType.Button",
        className: "Button",
        isEnabled: false,
        isVisible: true,
        x: 0,
        y: 0,
        width: 80,
        height: 24,
        value: "",
      },
      {
        name: "Static",
        automationId: "",
        controlType: "ControlType.Text",
        className: "TextBlock",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 40,
        width: 80,
        height: 24,
        value: "",
      },
    ]);

    expect(describeUiActionTargets(descriptors)).toEqual([
      {
        element_id: descriptors[0].element_id,
        selector: "[automationId='SaveButton']",
        name: "Save",
        control_type: "Button",
        role: "button",
        label: "Save",
        value: "",
        actions: ["click"],
        bounds: descriptors[0].bounds,
      },
    ]);
    expect(describeUiActionTargets(descriptors, 0)).toEqual([]);
  });

  it("discovers likely browser address targets from UIA descriptors", () => {
    const descriptors = describeUiElements([
      {
        name: "Address and search bar",
        automationId: "view_1021",
        controlType: "ControlType.Edit",
        className: "Chrome_WidgetWin_1",
        isEnabled: true,
        isVisible: true,
        x: 120,
        y: 50,
        width: 720,
        height: 36,
        value: "example.test/path",
      },
      {
        name: "Find on page",
        automationId: "find-box",
        controlType: "ControlType.Edit",
        className: "TextBox",
        isEnabled: true,
        isVisible: true,
        x: 0,
        y: 100,
        width: 200,
        height: 24,
        value: "",
      },
      {
        name: "Disabled address bar",
        automationId: "disabled-address",
        controlType: "ControlType.Edit",
        className: "TextBox",
        isEnabled: false,
        isVisible: true,
        x: 0,
        y: 130,
        width: 800,
        height: 24,
        value: "example.test/disabled",
      },
    ]);

    expect(describeUiBrowserTargets(descriptors)).toEqual([
      {
        element_id: descriptors[0].element_id,
        selector: "[automationId='view_1021']",
        edit_selector: "[automationId='view_1021']",
        kind: "address_bar",
        confidence: 1,
        label: "Address and search bar",
        value: "example.test/path",
        actions: ["type", "key"],
        bounds: descriptors[0].bounds,
        reasons: [
          "editable-textbox",
          "address-label",
          "edge-address-automation-id",
          "url-like-value",
          "wide-edit-control",
        ],
      },
    ]);
  });

  it("discovers search boxes separately from address bars", () => {
    const descriptors = describeUiElements([
      {
        name: "Search the web",
        automationId: "search",
        controlType: "ControlType.Edit",
        className: "TextBox",
        isEnabled: true,
        isVisible: true,
        x: 20,
        y: 40,
        width: 400,
        height: 28,
        value: "",
      },
    ]);

    expect(describeUiBrowserTargets(descriptors)).toEqual([
      expect.objectContaining({
        selector: "[automationId='search']",
        kind: "search_box",
        confidence: 0.6,
        reasons: ["editable-textbox", "search-label", "wide-edit-control"],
      }),
    ]);
  });
});
