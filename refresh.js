#!/usr/bin/env node

var _         = require('lodash');
var fs        = require('fs');
var execFile  = require('child_process').execFile;
var program   = require('commander');
var pkgInfo   = require('pkginfo')(module);
var Options   = require('options');
var async     = require('async');
var svn       = require('node-svn-ultimate');


var opts = null;
var config = null;
var startTime = null;
var endTime = null;


/**
 * Control flow is managed via async.waterfall() so methods are processed in series.
 * Provides the entry point to our program. It orchestrates the bootstrapping
 * of program info, validating arguments, loading options, and processing requests.
 *
 */
async.waterfall([

    setupProgramInfo,
    displayHeader,
    validateProgram,
    setupConfigOptions,
    processRequest

], function (err) {
    if (err) processError(err);
});

/**
 * Utility function for displaying an error back to the user and terminating execution.
 */
function processError (err) {
    console.log();
    console.log('Error: ' + err.message);
    console.log();
    process.exit();
}

/**
 * Establishes program usage information through command line configuration options. Sets --version based
 * on package.json version setting.
 */
function setupProgramInfo (callback) {
    program
        .version(module.exports.version)
        .option('-p, --project <project>', 'refresh a local svn project')
        .option('-w, --workspace <workspace>', 'refresh a local svn workspace comprised of multiple projects')
        .option('-c, --config <file>', 'path to configuration file - default path is current directory')
        .option('-b, --build', 'perform build for target project or workspace')
        .parse(process.argv);

    callback();
}

/**
 * Utility function to display custom header in console.
 */
function displayHeader (callback) {
    //  Display header unless help or version information requested.
    if (!_.includes(process.argv, '-h') ||
        !_.includes(process.argv, '--help') ||
        !_.includes(process.argv, '-V') ||
        !_.includes(process.argv, '--version')) {

        // let's clear the screen.
        process.stdout.write('\033c');

        // Display header.
        console.log('****************************************');
        console.log('*                                      *');
        console.log('*            DevToolz v' + module.exports.version + '           *');
        console.log('*                                      *');
        console.log('****************************************');
        console.log();
        console.log();
        console.log('utility: refresh');
        console.log();
        console.log();
        console.log();
    }

    callback();
}

/**
 * Validates the command line arguments, ensuring arguments are present, not in conflict
 * with one another, and config.json can be located.
 */
function validateProgram (callback) {
    var isValid = true;
    var errMsg = '';

    // Arguments must be set.
    if (process.argv.length <= 2) {
        isValid = false;
        errMsg = 'No arguments defined.';
    }

    // Refresh does not currently support both project and workspace simultaneously.
    if (program.project && program.workspace) {
        isValid = false;
        errMsg = 'Options --project and --workspace cannot be used together.';
    }

    // If already invalid, return error.
    if (!isValid) return callback(new Error(errMsg));

    // Set config path based on defined or default setting.
    var configPath = program.config ? program.config : 'config.json';

    // Check for config.json at set path.
    fs.access(configPath, fs.R_OK, function (err) {
        if (err) {
            return callback(new Error('Cannot locate --config value: ' + program.config));
        }

        callback(null, configPath);
    });
}

/**
 * Sets up configuration options based on config.json.
 */
function setupConfigOptions (configPath, callback) {
    // Setup default options.
    var defaultOptions = {
        reposRoot: null,
        buildConfig: null,
        projects: [],
        workspaces: []
    };
    opts = new Options(defaultOptions);
    config = opts.value;

    // Read config.json in defined path.
    opts.read(configPath, function (err) {
        if (err) return callback(err);

        // Check for valid build config.
        if (program.build && (!opts.isDefinedAndNonNull('buildConfig'))) {
            return callback(new Error('Using option --build but no "buildConfig" configuration defined.'));
        }

        callback();
    });
}

/**
 * Executes the requested process. The refresh utility supports refreshing an individual project,
 * or refreshing a workspace comprised of multiple projects.
 */
function processRequest (callback) {
    if (program.project) {
        // Let's first make sure the target project is configured.
        validateTargetProject(program.project, function (err, project) {
            if (err) return callback(err);

            startTime = new Date();

            console.log();
            refreshTargetProject(project, function (err) {
                if (err) return callback(err);

                endTime = new Date();

                console.log();
                console.log();
                displayProcessTime();
                console.log();

                callback();
            });
        });
    }

    if (program.workspace) {
        // Let's first make sure the target workspace is configured.
        validateTargetWorkspace(program.workspace, function (err, workspace) {
            if (err) return callback(err);

            startTime = new Date();

            console.log();
            refreshTargetWorkspace(workspace, function (err) {
                if (err) return callback(err);

                endTime = new Date();

                console.log();
                console.log();
                displayProcessTime();
                console.log();

                callback();
            });
        });
    }
}

/**
 * Validate target project is configured via config.json.
 */
function validateTargetProject (target, callback) {
    var targetProject = _.find(config.projects, _.matchesProperty('name', target));

    if (typeof targetProject === 'undefined') {
        return callback(new Error('Project ' + target + ' is not configured.'));
    }

    callback(null, targetProject);
}

/**
 * Validate target workspace is configured via config.json.
 */
function validateTargetWorkspace (target, callback) {
    var targetWorkspace = _.find(config.workspaces, _.matchesProperty('name', target));

    if (typeof targetWorkspace === 'undefined') {
        return callback(new Error('Workspace ' + target + ' is not configured.'));
    }

    callback(null, targetWorkspace);
}

/**
 * Refresh target project by updating local copy. Optionally, can perform a build.
 */
function refreshTargetProject (project, callback) {
    console.log('Refreshing ' + project.name + ':');
    process.stdout.write('  Updating local copy...');
    svn.commands.update(project.path, {quiet: false, force: true}, function (err, msg) {
        if (err) return callback(err);

        process.stdout.write('complete.\n');

        if (program.build) {
            var bc = _.clone(opts.value.buildConfig[project.buildTool], true),
                options = { cwd: project.buildPath, maxBuffer: 1000 * 1024 };

            if (project.buildTool === 'msbuild') {
                // Clone nuget config
                var nc = _.clone(opts.value.buildConfig.nuget, true);

                // Add sln file as second argument for nuget
                nc.buildArgs.splice(1, 0, project.slnFile);

                process.stdout.write('  Restoring nuget packages...');
                execFile(nc.buildFile, nc.buildArgs, options, function (err, stdout, stderr) {
                    // if (stdout) console.log(stdout);
                    if (stderr) console.log(stderr);
                    if (err) return callback(err);

                    process.stdout.write('complete.\n');

                    // Add sln file to arguments
                    bc.buildArgs.push(project.slnFile);

                    // Now let's build solution
                    process.stdout.write('  Rebuilding solution...');
                    execFile(bc.buildFile, bc.buildArgs, options, function (err, stdout, stderr) {
                        if (err) return callback(err);

                        process.stdout.write('complete.\n');
                        console.log();
                        callback();
                    });
                });

            } else {
                process.stdout.write('  Rebuilding solution...');
                execFile(bc.buildFile, bc.buildArgs, options, function (err, stdout, stderr) {
                    if (err) return callback(err);

                    process.stdout.write('complete.\n');
                    console.log();
                    callback();
                });
            }

        } else {
            console.log();
            callback();
        }
    });
}

/**
 * Refresh target workspace by updating local copies of projects. Optionally,
 * can perform a build on projects.
 */
function refreshTargetWorkspace (workspace, callback) {
    var targetProjects = [];

    _.forEach(workspace.projects, function (project, pi, allProjects) {
        var targetProject = _.find(config.projects, _.matchesProperty('name', project));

        if (typeof targetProject === 'undefined') {
            return callback(new Error('Workspace project ' + project + ' is not configured.'));
        }

        targetProjects.push(targetProject);
    });

    async.eachSeries(targetProjects, refreshTargetProject, function (err) {
        if (err) return callback(err);

        callback();
    });
}

/**
 * Utility function to display how long the requested process took to complete.
 */
function displayProcessTime () {
    var timeDiff = endTime - startTime;
    timeDiff /= 1000;
    var seconds = Math.round(timeDiff % 60);
    timeDiff = Math.floor(timeDiff / 60);
    var minutes = Math.round(timeDiff % 60);

    console.log('Refresh complete in ' + minutes + ' minutes and ' + seconds + ' seconds.');
}
