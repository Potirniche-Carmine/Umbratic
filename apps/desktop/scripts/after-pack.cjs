const fs = require("node:fs/promises");
const path = require("node:path");
const { getAppUpdatePublishConfiguration } = require("app-builder-lib/out/publish/PublishManager");

// electron-builder skips update configuration for --dir. Use its own resolver
// for every bundle so cache names and Windows publisher verification stay intact.
module.exports = async function afterPack({ packager, appOutDir, arch }) {
  const config = await getAppUpdatePublishConfiguration(packager, null, arch, true);
  if (!config) throw new Error("The packaged app requires an update feed configuration.");
  // JSON is valid YAML and avoids another serializer dependency.
  await fs.writeFile(path.join(packager.getResourcesDir(appOutDir), "app-update.yml"), `${JSON.stringify(config, null, 2)}\n`);
};
