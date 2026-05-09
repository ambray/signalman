import { describe, expect, it } from "vitest";

import { describeUiElements } from "../guest/ui-elements.js";
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
});
