import _ from 'underscore';
import util from 'util';
import path from 'path';
import assert from 'assert';
import chalk from 'chalk';

import isopackets from '../tool-env/isopackets.js'
import files from '../fs/files.js';
import utils from '../utils/utils.js';
import { Console } from '../console/console.js';
import buildmessage from '../utils/buildmessage.js';
import main from '../cli/main.js';
import httpHelpers from '../utils/http-helpers.js';

import { AVAILABLE_PLATFORMS, displayNameForPlatform } from './index.js';
import { CordovaBuilder } from './builder.js';

function loadDependenciesFromCordovaPackageIfNeeded() {
  if (typeof Cordova !== 'undefined') return;

  ({ Cordova } = isopackets.load('cordova-support').cordova);
  ({ cordova, events, CordovaError, superspawn, cordova_util } = Cordova);

  events.on('results', logIfVerbose);
  events.on('log', logIfVerbose);
  events.on('warn', log);
  // events.on('verbose', logIfVerbose);
}

function logIfVerbose(...args) {
  if (Console.verbose) {
    log(...args);
  }
};

function log(...args) {
  Console.rawInfo(`%% ${util.format.apply(null, args)}\n`);
}

export class CordovaProject {
  constructor(projectContext, appName = files.pathBasename(projectContext.projectDir)) {
    loadDependenciesFromCordovaPackageIfNeeded();

    this.projectContext = projectContext;

    this.projectRoot = projectContext.getProjectLocalDirectory('cordova-build');
    this.appName = appName;

    this.pluginsDir = files.pathJoin(this.projectRoot, 'plugins');
    this.localPluginsDir = files.pathJoin(this.projectRoot, 'local-plugins');
    this.tarballPluginsLockPath = files.pathJoin(this.projectRoot, 'cordova-tarball-plugins.json');

    this.createIfNeeded();
  }

  createIfNeeded() {
    if (!files.exists(this.projectRoot)) {
      files.mkdir_p(files.pathDirname(this.projectRoot));
      // Cordova app identifiers have to look like Java namespaces.
      // Change weird characters (especially hyphens) into underscores.
      const appId = 'com.meteor.userapps.' + this.appName.replace(/[^a-zA-Z\d_$.]/g, '_');

      Console.debug('Creating Cordova project');

      // Don't set cwd to project root in runCommands because it doesn't exist yet
      this.runCommands(async () => {
        await cordova.raw.create(files.convertToOSPath(this.projectRoot), appId, this.appName);
      }, undefined, null);
    }
  }

  // Preparing

  prepareFromAppBundle(bundlePath, plugins, options = {}) {
    assert(bundlePath);
    assert(plugins);

    Console.debug('Preparing Cordova project from app bundle');

    const builder = new CordovaBuilder(this, bundlePath, plugins, options);
    builder.start();
  }

  prepareForPlatform(platform) {
    assert(platform);

    const commandOptions = _.extend(this.defaultOptions,
      { platforms: [platform] });

    Console.debug('Preparing Cordova project', commandOptions);

    this.runCommands(async () => {
      await cordova.raw.prepare(commandOptions);
    });
  }

  // Building (includes prepare)

  buildForPlatform(platform, options = [], extraPaths) {
    assert(platform);

    const commandOptions = _.extend(this.defaultOptions,
      { platforms: [platform], options: options });

    Console.debug('Building Cordova project', commandOptions);

    this.runCommands(async () => {
      await cordova.raw.build(commandOptions);
    });
  }

  // Running (incudes build)

  async run(platform, isDevice, options = [], extraPaths) {
    options.push(isDevice ? '--device' : '--emulator');

    const env = this.defaultEnvWithPathsAdded(...extraPaths);
    const commandOptions = _.extend(this.defaultOptions,
      { platforms: [platform], options: options });

    Console.debug('Running Cordova project', commandOptions);

    this.runCommands(async () => {
      await cordova.raw.run(commandOptions);
    }, env);
  }

  // Platforms

  checkPlatformRequirements(platform) {
    if (platform === 'ios' && process.platform !== 'darwin') {
      Console.warn("Currently, it is only possible to build iOS apps on an OS X system.");
      return false;
    }

    const installedPlatforms = this.listInstalledPlatforms();
    const inProject = _.contains(installedPlatforms, platform);
    if (!inProject) {
      Console.warn(`Please add the ${displayNameForPlatform(platform)} \
platform to your project first.`);
      Console.info(`Run: ${Console.command(`meteor add-platform ${platform}`)}`);
      return false;
    }

    const allRequirements = this.runCommands(
      async () => {
        return await cordova.raw.requirements([platform], this.defaultOptions);
      });
    let requirements = allRequirements && allRequirements[platform];
    if (!requirements) {
      Console.error(`Failed to check requirements for platform \
${displayNameForPlatform(platform)}`);
      return false;
    } else if (requirements instanceof CordovaError) {
      Console.error(`cordova: ${requirements.message}`);
      return false;
    }

    // We don't use ios-deploy, but open Xcode to run on a device instead
    requirements = _.reject(requirements, requirement => requirement.id === 'ios-deploy');

    const satisfied = _.every(requirements, requirement => requirement.installed);
    if (!satisfied) {
      Console.info();
      Console.info(`Make sure all installation requirements are satisfied \
before running or building for ${displayNameForPlatform(platform)}:`);
      for (requirement of requirements) {
        const name = requirement.name;
        if (requirement.installed) {
          Console.success(name);
        } else {
          const reason = requirement.metadata && requirement.metadata.reason;
          if (reason) {
            Console.failInfo(`${name}: ${reason}`);
          } else {
            Console.failInfo(name);
          }
        }
      }
    }
    return satisfied;
  }

  listInstalledPlatforms() {
    return cordova_util.listPlatforms(files.convertToOSPath(this.projectRoot));
  }

  updatePlatforms(platforms = this.listInstalledPlatforms()) {
    this.runCommands(async () => {
      await cordova.raw.platform('update', platforms, this.defaultOptions);
    });
  }

  addPlatform(platform) {
    this.runCommands(async () => {
      await cordova.raw.platform('add', platform, this.defaultOptions);
    });
  }

  removePlatform(platform) {
    this.runCommands(async () => {
      await cordova.raw.platform('rm', platform, this.defaultOptions);
    });
  }

  get cordovaPlatformsInApp() {
    return this.projectContext.platformList.getCordovaPlatforms();
  }

  // Ensures that the Cordova platforms are synchronized with the app-level
  // platforms.
  ensurePlatformsAreSynchronized(platforms = this.cordovaPlatformsInApp) {
    buildmessage.assertInCapture();

    const installedPlatforms = this.listInstalledPlatforms();

    for (platform of platforms) {
      if (_.contains(installedPlatforms, platform)) continue;

      this.addPlatform(platform);
    }

    for (platform of installedPlatforms) {
      if (!_.contains(platforms, platform) &&
        _.contains(AVAILABLE_PLATFORMS, platform)) {
        this.removePlatform(platform);
      }
    }
  }

  // Plugins

  listInstalledPlugins() {
    const pluginsMetadata = JSON.parse(files.readFile(
      files.pathJoin(this.pluginsDir, 'fetch.json'), 'utf8'));
    const installedPlugins = _.object(_.map(pluginsMetadata, (metadata, name) => {
      const source = metadata.source;
      let version;
      if (source.type === 'registry') {
        version = source.id.split('@')[1];
      } else if (source.type === 'git') {
        version = `${source.url}#${source.ref}`;
      } else if (source.type === 'local') {
        version = source.path;
      }
      return [name, version];
    }));
    return installedPlugins;
  }

  convertToGitUrl(url) {
    // Matches GitHub tarball URLs, like:
    // https://github.com/meteor/com.meteor.cordova-update/tarball/92fe99b7248075318f6446b288995d4381d24cd2
    const match =
      url.match(/^https?:\/\/github.com\/(.+?)\/(.+?)\/tarball\/([0-9a-f]{40})/);
    if (match) {
        const [,organization,repository,sha] = match;
      // Convert them to a Git URL
      return `https://github.com/${organization}/${repository}.git#${sha}`;
    } else if (/\.git/.test(url)) {
      return url;
    } else {
      throw new Error(`Meteor no longer supports installing Cordova plugins \
from tarball URLs. Cordova requires a Git URL to install from.`);
    }
  }

  targetForPlugin(name, version) {
    if (!version) {
      return name;
    }

    if (utils.isUrlWithSha(version)) {
      return this.convertToGitUrl(version);
    } else if (utils.isUrlWithFileScheme(version)) {
      // Strip file:// and compute the relative path from plugin to corodova-build
      return files.convertToOSPath(this.resolveCordovaLocalPluginPath(version));
    } else {
      return `${name}@${version}`;
    }
  }

  addPlugin(name, version, config) {
    Console.debug('Adding Cordova plugin', name);

    const target = this.targetForPlugin(name, version);

    // TODO Pass config attributes to Cordova command

    this.runCommands(async () => {
      await cordova.raw.plugin('add', target, this.defaultOptions);
    });
  }

  removePlugins(pluginsToRemove) {
    Console.debug('Removing Cordova plugins', pluginsToRemove);

    if (_.isEmpty(pluginsToRemove)) return;

    this.runCommands(async () => {
      await cordova.raw.plugin('rm', pluginsToRemove, this.defaultOptions);
    });
  }

  // Strips the file:// from the path and if a relative path was used, it translates it to a relative path to the
  // cordova-build directory instead of meteor project directory.
  resolveCordovaLocalPluginPath(pluginPath) {
    pluginPath = pluginPath.substr("file://".length);
    if (utils.isPathRelative(pluginPath)) {
      return path.relative(
        this.projectRoot,
        path.resolve(this.projectContext.projectDir, pluginPath));
    } else {
      return pluginPath;
    }
  }

  // Ensures that the Cordova plugins are synchronized with the app-level
  // plugins.
  ensurePluginsAreSynchronized(plugins, pluginsConfiguration = {}) {
    assert(plugins);

    buildmessage.assertInCapture();

    const installedPlugins = this.listInstalledPlugins();

    // Due to the dependency structure of Cordova plugins, it is impossible to
    // upgrade the version on an individual Cordova plugin. Instead, whenever a
    // new Cordova plugin is added or removed, or its version is changed,
    // we just reinstall all of the plugins.
    let shouldReinstallAllPlugins = false;

    // Iterate through all of the plugins and find if any of them have a new
    // version. Additionally check if we have plugins installed from local path.
    const pluginsFromLocalPath = {};
    _.each(plugins, (version, name) => {
      // Check if plugin is installed from local path
      const isPluginFromLocalPath = utils.isUrlWithFileScheme(version);

      if (isPluginFromLocalPath) {
        pluginsFromLocalPath[name] = version;
      } else {
        if (utils.isUrlWithSha(version)) {
          version = this.convertToGitUrl(version);
        }

        if (!_.has(installedPlugins, name) ||
          installedPlugins[name] !== version) {
          // We do not have the plugin installed or the version has changed.
          shouldReinstallAllPlugins = true;
        }
      }
    });

    if (!_.isEmpty(pluginsFromLocalPath)) {
      Console.debug('Reinstalling Cordova plugins added from the local path');
    }

    // Check to see if we have any installed plugins that are not in the current
    // set of plugins.
    _.each(installedPlugins, (version, name) => {
      if (!_.has(plugins, name)) {
        shouldReinstallAllPlugins = true;
      }
    });

    if (shouldReinstallAllPlugins || !_.isEmpty(pluginsFromLocalPath)) {
      buildmessage.enterJob({ title: "installing Cordova plugins"}, () => {
        let pluginsToRemove;
        if (shouldReinstallAllPlugins) {
          pluginsToRemove = Object.keys(installedPlugins);
        } else {
          // Only try to remove plugins that are currently installed
          pluginsToRemove = _.intersection(
            Object.keys(pluginsFromLocalPath),
            Object.keys(installedPlugins));
        }

        this.removePlugins(pluginsToRemove);

        // Now install necessary plugins.

        if (shouldReinstallAllPlugins) {
          pluginsToInstall = plugins;
        } else {
          pluginsToInstall = pluginsFromLocalPath;
        }

        const pluginsCount = _.size(pluginsToInstall);
        let pluginsInstalled = 0;

        buildmessage.reportProgress({ current: 0, end: pluginsCount });
        _.each(pluginsToInstall, (version, name) => {
          this.addPlugin(name, version, pluginsConfiguration[name]);

          buildmessage.reportProgress({
            current: ++pluginsInstalled,
            end: pluginsCount
          });
        });
      });
    }
  };

  // Cordova commands support

  get defaultOptions() {
    return { silent: !Console.verbose, verbose: Console.verbose };
  }

  defaultEnvWithPathsAdded(...extraPaths) {
    let paths = (this.defaultPaths || []);
    paths.unshift(...extraPaths);
    const env = files.currentEnvWithPathsAdded(...paths);
    return env;
  }

  get defaultPaths() {
    const nodeBinDir = files.getCurrentNodeBinDir();
    return [nodeBinDir];
  }

  runCommands(asyncFunc, env = this.defaultEnvWithPathsAdded(),
    cwd = this.projectRoot) {
    const oldCwd = process.cwd();
    if (cwd) {
      process.chdir(files.convertToOSPath(cwd));
    }

    superspawn.setEnv(env);

    try {
      return Promise.await(asyncFunc());
    } catch (error) {
      if (error instanceof CordovaError) {
        Console.error(`cordova: ${error.message}`);
        Console.error(chalk.green("Try running again with the --verbose option \
to help diagnose the issue."));
        throw new main.ExitWithCode(1);
      } else {
        throw error;
      }
    } finally {
      if (oldCwd) {
        process.chdir(oldCwd);
      }
    }
  }
}
