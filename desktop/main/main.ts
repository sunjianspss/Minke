import { app } from "electron";
import started from "electron-squirrel-startup";
import { runDesktopApplication } from "./application";
import {
  isCredentialStorageHelperProcess,
  runCredentialStorageHelper,
} from "./credential-storage-helper";
// >>> minke-fork
import { installMinkeSkinStore } from "./minke-skin-store.ts";
// <<< minke-fork

if (isCredentialStorageHelperProcess()) {
  void runCredentialStorageHelper().then(
    (exitCode) => {
      app.exit(exitCode);
    },
    () => {
      app.exit(1);
    },
  );
} else if (started) {
  app.quit();
} else {
  runDesktopApplication();
  // >>> minke-fork
  // 皮肤选择的读写通道。放在这条分支里：凭据助手那个子进程没有窗口，
  // 也就不需要这两个 handler。
  installMinkeSkinStore();
  // <<< minke-fork
}
