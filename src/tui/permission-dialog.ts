import { Box, Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { PromptOutcome, PermissionRequestView } from "../permissions/manager.js";
import { fg, bold, selectListTheme } from "./theme.js";
import { SelectList } from "@earendil-works/pi-tui";

/**
 * Modal permission dialog:
 *
 *   TinyCode wants to run: <title>
 *   <detail>
 *   › Allow once
 *     Always allow this pattern
 *     Deny
 */
export function showPermissionDialog(
  tui: TUI,
  request: PermissionRequestView,
): Promise<PromptOutcome> {
  return new Promise<PromptOutcome>((resolve) => {
    const title = new Text(
      `${bold(fg.brightYellow("Permission"))} ${fg.brightYellow("TinyCode wants to run:")}`,
    );
    const body = new Text(`  ${request.title}`);
    const detail =
      request.detail && request.detail.length > 0
        ? new Text(`${fg.gray(indentClip(request.detail))}`)
        : undefined;
    const reason = request.reason ? new Text(`  ${fg.gray(request.reason)}`) : undefined;

    const list = new SelectList(
      [
        { value: "once", label: "Allow once" },
        { value: "always", label: "Always allow this pattern" },
        { value: "deny", label: "Deny", description: request.reason },
      ],
      5,
      selectListTheme,
    );

    const box = new Box(1, 1);
    box.addChild(title);
    box.addChild(body);
    if (detail) box.addChild(detail);
    if (reason) box.addChild(reason);
    box.addChild(list);

    const handle = tui.showOverlay(box, {
      width: Math.min(72, Math.max(50, request.title.length + 12)),
      anchor: "center",
    });
    handle.focus();

    let settled = false;
    const finish = (outcome: PromptOutcome) => {
      if (settled) return;
      settled = true;
      handle.hide();
      resolve(outcome);
    };

    list.onSelect = (item) => finish(item.value as PromptOutcome);
    list.onCancel = () => finish("deny");
  });
}

function indentClip(text: string, maxLines = 12): string {
  const lines = text.split("\n").slice(0, maxLines).map((line) => `  ${line}`);
  if (text.split("\n").length > maxLines) lines.push("  …");
  return lines.join("\n");
}
