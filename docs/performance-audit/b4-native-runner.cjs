const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs");
exports.run = async () => {
  const extension = vscode.extensions.getExtension("appleton.camber-assistant");
  assert(extension);
  const start = performance.now();
  await extension.activate();
  const activationMs = performance.now() - start;
  assert(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  const expected = [
    "focusInput",
    "togglePlanMode",
    "newConversation",
    "resetConfiguration",
    "showSidebar",
    "openPermissionSettings",
    "openSettings",
  ];
  for (const command of expected) assert(commands.includes(`camber.${command}`), command);
  await vscode.commands.executeCommand("camber.togglePlanMode");
  const configuration = vscode.workspace.getConfiguration("camber");
  assert.equal(configuration.get("notifyOnApproval"), true);
  assert.equal(configuration.get("toolActivity"), "grouped");
  fs.writeFileSync(
    process.env.CAMBER_B4_RESULT,
    JSON.stringify({
      activationMs,
      commands: expected,
      active: extension.isActive,
      vscode: vscode.version,
    }),
  );
};
