'use strict';

let gImportOptions = {
  'remove': false,
  'replace': true,
};


async function onFileChange(event) {
  let fileObj = event.target.files[0];

  let zipPromise = JSZip.loadAsync(fileObj, {
    'checkCRC32': true,
    'createFolders': true,
  });
  let userScriptsPromise = browser.runtime.sendMessage(
      {'name': 'ListUserScripts', 'includeDisabled': true});
  await Promise.all([zipPromise, userScriptsPromise]).then(async promisedValues => {
    let [zip, userScripts] = promisedValues;
    let installedIdToUuid = userScripts.reduce((set, val) => {
      let userScript = new RunnableUserScript(val);
      set[userScript.id] = userScript.uuid;
      return set;
    }, {});
    await importAllScriptsFromZip(zip, installedIdToUuid);
  });
}


async function importAllScriptsFromZip(zip, installedIdToUuid) {
  // The namespace-and-name ID of all user scripts in the zip.
  let importedIds = new Set();

  let userScriptFiles = zip.file(/\.user\.js$/);
  for (let i = 0, file = null; file = userScriptFiles[i]; i++) {
    await importOneScriptFromZip(zip, file, installedIdToUuid, importedIds);
  }

  if (gImportOptions.remove) {
    let installedNotImportedIds = [...Object.keys(installedIdToUuid)]
        .filter(x => !importedIds.has(x));
    for (let installedId of installedNotImportedIds) {
      chrome.runtime.sendMessage({
        'name': 'UserScriptUninstall',
        'uuid': installedIdToUuid[installedId],
      }, logUnhandledError);
    }
  }
}


async function importOneScriptFromZip(zip, file, installedIds, importedIds) {
  let exportDetails = {'enabled': true};
  let content = await file.async('text');

  let downloader = new UserScriptDownloader();
  downloader.setScriptContent(content);

  if (!file.name.includes('/')) {
    downloader.setScriptUrl('file:///' + file.name);
  } else {
    let folderName = file.name.substr(0, file.name.lastIndexOf('/'));

    let exportDetails = await zip.file(`${folderName}/.gm.json`)
        .async('text')
        .then(JSON.parse);
    let urlMap = {};
    if (zip.file(`${folderName}/.files.json`)) {
      urlMap = await zip.file(`${folderName}/.files.json`)
          .async('text')
          .then(JSON.parse);
    }

    fillDownloaderFromZipFolder(
        downloader, zip, content, exportDetails, urlMap);
  }

  await downloader.start();
  let userScript = new RemoteUserScript(await downloader.scriptDetails);

  if (gImportOptions.replace || !installedIds.has(userScript.id)) {
    importedIds.add(userScript.id);
    await downloader.install(/*disabled=*/!exportDetails.enabled);
  }
}


function fillDownloaderFromZipFolder(
    downloader, zip, scriptContent, exportDetails, urlMap) {
  downloader.setScriptUrl(exportDetails.downloadUrl);

  let parsedDetails = parseUserScript(scriptContent, exportDetails.downloadUrl);

  // TODO: Icon.

  let requires = {};
  parsedDetails.requireUrls.forEach(u => {
    requires[u] = zip.file(urlMap[u]).async('text');
  });
  downloader.setKnownRequires(requires);

  let resources = {};
  Object.values(parsedDetails.resourceUrls).forEach(u => {
    resources[u] = zip.file(urlMap[u]).async('blob');
  });
  downloader.setKnownResources(resources);

  // TODO: Stored values.

  return downloader;
}
