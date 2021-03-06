const waifu2x = require("waifu2x").default
const { app, BrowserWindow, ipcMain, screen } = require('electron')
if (require('electron-squirrel-startup')) app.quit();
if (handleSquirrelEvent()) {
    app.quit()
}
const os = require('os');
const isDev = require('electron-is-dev')
const path = require("path");
const fs = require('fs').promises
const fsSync = require('fs')
const sanitize = require("sanitize-filename")
const openExplorer = require('open-file-explorer');
const { shell } = require('electron')
const { dialog } = require('electron')
const isVideo = require('is-video');
const ffmpegPath = path.resolve(__dirname, "../ffmpeg")
const ffmpegPrefix = os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const Semaphore = require("semaphore")
//----------------------------------------------------------//
//----------------------------------------------------------//
//----------------------------------------------------------//


let globalOutput = {
    usesDefault: true,
    path: ""
}
let currentExecution = 0
//-------------------------------------//

let emitError = function (error) {
    console.error(error)
    if (mainWindow === null) return
    mainWindow.webContents.send("log-error", error)
}
process.on('uncaughtException', emitError)
process.on("unhandledRejection", emitError)
process.on("uncaughtExceptionMonitor", emitError)

//-------------------------------------//

ipcMain.on("get-models", async (event) => {
    let models = await fs.readdir(path.join(__dirname, "../models/"))
    models.unshift("Drawing")
    event.reply("got-models", models)
})

ipcMain.on('open-folder', async (event, arg) => {
    let endPath = path.join(__dirname, "/results")
    if (!globalOutput.usesDefault) endPath = globalOutput.path
    openExplorer(endPath)
})

//-------------------------------------//

ipcMain.on('change-dest', async (event, arg) => {
    let path = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (!path.canceled) {
        globalOutput = {
            usesDefault: false,
            path: path.filePaths[0]
        }
    }
    event.reply('change-dest-answer', [true, globalOutput.path])
})

//-------------------------------------//

ipcMain.on("cancel-execution", (event, data) => {
    console.log("cancelled")
    currentExecution = new Date().getTime()
})

//-------------------------------------//

ipcMain.on("exec-function", (event, data) => {
    if (mainWindow === null) return
    switch (data.name) {
        case "close": {
            app.quit()
            process.exit(1)
            break
        }
        case "minimize": {
            mainWindow.minimize()
            break
        }
        case "open": {
            shell.openExternal(data.data)
            break
        }
        case "reload": {
            currentExecution = new Date().getTime()
            mainWindow.reload()
            break
        }
        case "resize": {
            mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
            break
        }
    }

})

//-------------------------------------//


function withSemaphore(sema, f) {
    return new Promise((resolve) => {
        sema.take(() => f().then(sema.leave).then(resolve))
    })
}



ipcMain.on('execute-waifu', async (event, arg) => {
    if (!Number.isInteger(arg.maxUpscales)) arg.maxUpscales = 4
    let sem = new Semaphore(arg.maxUpscales)
    currentExecution = new Date().getTime()
    let localExecution = currentExecution
    let calc = async (el) => {
        if (currentExecution !== localExecution) return
        let noise = 0
        let isVidOrGif = getFormat(el.name) === ".gif" || el.isVideo
        switch (el.noise) {
            case "Low": noise = 1
                break;
            case "Medium": noise = 2
                break;
            case "High": noise = 3
        }
        if (el.endPath !== "default") {
            globalOutput = {
                usesDefault: false,
                path: el.endPath
            }
        } else {
            globalOutput.usesDefault = true
        }
        let options = {
            noise: noise,
            scale: el.scale,
        }
        if (el.model !== "Drawing") {
            options.modelDir = path.join(__dirname, "../models/", el.model)
        }
        let safeName = sanitize(el.name)
        let outputFile = isVidOrGif ? safeName : replaceFormat(safeName, el.format)
        let date = new Date()
        let dailyFolder = + date.getDate() + "-" + (date.getMonth() + 1)

        event.reply('update-execution', {
            id: el.id,
            status: "pending"
        })

        let output
        let endPath = __dirname + "/results/" + dailyFolder
        if (!globalOutput.usesDefault) endPath = globalOutput.path + "/" + dailyFolder
        endPath += "/"
        if (!fsSync.existsSync(endPath)) {
            fsSync.mkdirSync(endPath, { recursive: true });
        }
        endPath += outputFile
        endPath = endPath.replace(/\//g, "\\")

        let reply = {
            id: el.id,
            message: output,
            success: true,
            status: "done",
            upscaledImg: null,
        }
        let callback = (current, final) => {
            if (currentExecution !== localExecution) return true
            if(reply.success === true){
                event.reply('update-execution', {
                    id: el.id,
                    status: "processing",
                    frames: [current, final]
                })
            }
        }

        if (getFormat(el.name) === ".gif") {
            //IF THE FILE IS A GIF
            options.speed = el.speed
            options.parallelFrames = arg.parallelFrames
            options.cumulative= true 
            try{
                reply.output = await waifu2x.upscaleGIF(el.path, endPath, options, callback)
            }catch(e){
                console.log("Error",e)
                reply.success = false
                reply.output = e.toString()
            }
            
        } else if (isVideo(el.path)) {
            //IF THE FILE IS A VIDEO
            let videoOptions = {
                quality: 0,
                noise: noise,
                scale: el.scale,
                ffmpegPath: path.resolve(ffmpegPath, ffmpegPrefix),
                parallelFrames: arg.parallelFrames
            }
            try{
                reply.output = await waifu2x.upscaleVideo(el.path, endPath, videoOptions, callback)
            }catch(e){
                console.log("Error",e)
                reply.success = false
                reply.output = e.toString()
            }

        } else {
            //IF THE FILE IS A PHOTO
            try {
                reply.output = await waifu2x.upscaleImage(el.path, endPath, options)
            } catch (e) {
                console.log("Error",e)
                reply.success = false
                reply.output = e.toString()
            }

        }
        try {
            let upscaledImg = await fs.readFile(endPath, { encoding: "base64" })
            let base = "data:image/"
            if (isVideo(el.name)) base = "data:video/"
            let endFormat = el.format === "Original" || isVidOrGif ? getFormat(el.name, true) : getFormat(el.format, true)
            reply.upscaledImg = base + endFormat + ";base64," + upscaledImg

        } catch (e) {
            console.log("Error finding file ", e)
            reply.success = false
            reply.output = e.toString()
        }
        if (currentExecution !== localExecution) return console.log("stopped execution")
        event.reply('done-execution', reply)

    }
    await Promise.all(arg.files.map(file => {
        return withSemaphore(sem, () => calc(file))
    }))
    mainWindow.flashFrame(true)
    setTimeout(() => mainWindow.flashFrame(false), 6000)

})

//----------------------------------------------------------//
//----------------------------------------------------------//
//----------------------------------------------------------//

function replaceFormat(path, newFormat) {
    if (newFormat === "Original") return path
    let regex = new RegExp('\.[^.\\\/:*?"<>|\r\n]+$')
    return path.replace(regex, newFormat)
}

//-------------------------------------//

function getFormat(path, noExtension = false) {
    let regex = new RegExp('\.[^.\\\/:*?"<>|\r\n]+$')
    let result = path.match(regex)[0] || ".png"
    if (noExtension) result = result.replace(".", "")
    return result
}

//-------------------------------------//

let mainWindow
function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 1000,
        alwaysOnTop: true,
        minHeight: screen.height,
        backgroundColor: "#7f7ba6",
        minWidth: 720,
        icon: path.join(__dirname, "../public/icons/icon.png"),
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            preload: __dirname + '/preload.js'
        }
    })

    if (isDev) {
        mainWindow.loadURL("http://localhost:3000")
    } else {
        mainWindow.loadURL('file://' + path.join(__dirname, "..\\build\\index.html"))
    }
    mainWindow.maximize()
    mainWindow.on('closed', () => (mainWindow = null));
    mainWindow.webContents.on('did-finish-load', () => {
        if (splash) {
            splash.close();
        }
        mainWindow.show();
        setTimeout(() => {
            mainWindow.setAlwaysOnTop(false)
        }, 200)
    })
}

//-------------------------------------//

let splash
function loadSplash() {
    splash = new BrowserWindow({
        width: screen.width,
        height: screen.height,
        minWidth: screen.width,
        minHeight: screen.height,
        icon: path.join(__dirname, "../public/icons/icon.png"),
        frame: false,
        alwaysOnTop: true
    })
    splash.loadURL(
        'file://' + __dirname + '/splash.html'
    )
    splash.on('closed', () => (splash = false));
    splash.webContents.on('did-finish-load', () => {
        splash.show()
        splash.maximize()
    });
}

//-------------------------------------//

app.whenReady().then(() => {
    loadSplash()
    createWindow()
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit()
})



//----------------------------------------------------------//
//----------------------------------------------------------//
//----------------------------------------------------------//

function handleSquirrelEvent() {
    if (process.argv.length === 1) {
        return false;
    }

    const ChildProcess = require('child_process');
    const path = require('path');

    const appFolder = path.resolve(process.execPath, '..');
    const rootAtomFolder = path.resolve(appFolder, '..');
    const updateDotExe = path.resolve(path.join(rootAtomFolder, 'Update.exe'));
    const exeName = path.basename(process.execPath);

    const spawn = function (command, args) {
        let spawnedProcess, error;

        try {
            spawnedProcess = ChildProcess.spawn(command, args, { detached: true });
        } catch (error) { }

        return spawnedProcess;
    };

    const spawnUpdate = function (args) {
        return spawn(updateDotExe, args);
    };

    const squirrelEvent = process.argv[1];
    switch (squirrelEvent) {
        case '--squirrel-install':
        case '--squirrel-updated':
            // Optionally do things such as:
            // - Add your .exe to the PATH
            // - Write to the registry for things like file associations and
            //   explorer context menus

            // Install desktop and start menu shortcuts
            spawnUpdate(['--createShortcut', exeName]);

            setTimeout(app.quit, 1000);
            return true;

        case '--squirrel-uninstall':
            // Undo anything you did in the --squirrel-install and
            // --squirrel-updated handlers

            // Remove desktop and start menu shortcuts
            spawnUpdate(['--removeShortcut', exeName]);

            setTimeout(app.quit, 1000);
            return true;

        case '--squirrel-obsolete':
            // This is called on the outgoing version of your app before
            // we update to the new version - it's the opposite of
            // --squirrel-updated

            app.quit();
            return true;
    }
};