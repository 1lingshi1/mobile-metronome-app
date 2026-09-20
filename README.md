# 手机节拍器（Android Metronome）

一个面向 Android 的本地节拍器应用，使用 Web 技术构建界面，并通过 Capacitor 接入 Android 原生能力。节拍计时与音频合成都运行在原生前台媒体服务中，可在应用进入后台或锁屏后继续播放。

## 功能特性

- 速度范围为 30–350 BPM，支持滑杆拖动与单步增减。
- 支持 2/4、3/4、4/4、6/8、9/8、12/8、5/4、7/4 等拍号。
- 自动生成重音与复合拍重音，并通过节拍轨迹显示当前拍点。
- 使用 Android `AudioTrack` 实时合成节拍声音，不依赖预置音频文件。
- 提供“机械节拍”和“鼓机”两种音色。
- 可调节总音量、明亮度、第一拍、特殊拍和其他拍的响度。
- 提供“响亮”“清脆”“厚重”三组快速预设，并支持即时试听。
- 支持应用内选择本地图片作为背景，图片会压缩后保存在设备本地。
- 支持开始、暂停、重置以及运行状态同步。
- 返回前台后自动同步当前节拍位置，前台、后台与锁屏状态保持一致。
- 设置和自定义背景默认保存在本机应用数据中，不依赖远程服务。

## 技术栈

- HTML5、CSS3、原生 JavaScript ES Modules
- Capacitor 8
- Android 原生 Java、前台媒体服务、AudioTrack
- Android Gradle Plugin 8.13、Gradle 8.14.3
- Node.js 测试脚本，无额外测试框架依赖
- 最低 Android 7.0（API 24），目标 API 36

## 目录结构

```text
.
├─ www/                         Web UI、节拍状态代理与功能模块
├─ android/                     Capacitor Android 工程
│  └─ app/src/main/java/
│     └─ com/mobilemetronome/app/
│        ├─ BackgroundMetronomePlugin.java
│        └─ BackgroundMetronomeService.java
├─ tests/                       核心逻辑与功能回归测试
├─ capacitor.config.json        Capacitor 配置
└─ package.json                 npm 脚本与项目依赖
```

## 环境要求

- Node.js 22 或更高版本
- JDK 17
- Android Studio，并安装 Android SDK Platform 36
- Android 真机或模拟器
- Windows、macOS 或 Linux

如果 PowerShell 阻止执行 `npm.ps1`，可使用 `npm.cmd` 和 `npx.cmd` 代替对应命令。

## 安装与检查

```bash
npm install
npm test
npm run check
```

`npm test` 用于运行核心逻辑和功能回归测试；`npm run check` 用于检查主要 JavaScript 文件的语法。

## 同步与运行

将 Web 资源同步到 Android 工程：

```bash
npx cap sync android
```

通过已连接的设备或模拟器运行：

```bash
npx cap run android
```

也可以使用 Android Studio 打开原生工程并运行：

```bash
npx cap open android
```

修改 `www/`、插件接口或依赖后，建议重新执行：

```bash
npx cap sync android
```

## 构建 Android 安装包

调试构建：

```powershell
cd android
.\gradlew.bat assembleDebug
```

macOS 或 Linux：

```bash
cd android
./gradlew assembleDebug
```

调试 APK 默认位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

发布签名版前，请先在 Android Studio 或 Gradle 中配置自己的签名信息，然后执行：

```powershell
.\gradlew.bat assembleRelease
```

请勿将签名文件、密码、`keystore` 或 `local.properties` 提交到仓库。

## 发布 APK

建议将 APK 作为 GitHub Releases 的附件发布，不要直接把安装包提交到 Git 仓库。当前 `.gitignore` 已排除 `*.apk`、`*.aab`、签名文件和本地签名配置。

发布前请完成以下检查：

1. 确认 `android/app/build.gradle` 中的 `versionCode` 和 `versionName` 已更新。
2. 使用正式签名密钥构建 release APK，不要公开上传 debug APK。
3. 在至少一台干净设备或模拟器上完成安装与启动测试。
4. 确认 APK 中没有账号、Token、API Key、测试地址或其他敏感数据。
5. 妥善保存签名密钥和密码；后续版本必须使用同一密钥签名，丢失后无法直接覆盖升级。

可以在 Android Studio 中通过 `Build > Generate Signed App Bundle or APK` 生成签名 APK。配置好 Gradle 签名信息后，也可以使用命令构建：

```powershell
cd android
.\gradlew.bat clean assembleRelease
```

签名 APK 通常位于：

```text
android/app/build/outputs/apk/release/app-release.apk
```

生成校验值：

```powershell
Get-FileHash .\app\build\outputs\apk\release\app-release.apk -Algorithm SHA256
```

创建版本标签并推送：

```powershell
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

随后在 GitHub 的 `Releases` 页面创建新版本，选择对应标签，上传 APK，并在说明中附上 SHA-256 校验值。不要将签名密钥、密码或 `keystore.properties` 上传到仓库。APK 可以被解包和分析，因此不应在安装包中嵌入任何机密信息。

## 数据与权限说明

- 应用没有账号系统或业务后端，声音设置、音色选择和自定义背景由应用保存在设备本地。是否参与 Android 系统备份由系统设置和设备策略决定。
- Android 前台服务用于后台与锁屏播放，并会显示媒体通知。
- 通知权限用于展示运行状态；电池优化设置入口用于提高后台播放稳定性。
- Android 工程保留 Capacitor 常规的 `INTERNET` 权限。若确认发布版本完全不需要网络能力，可在完整回归测试通过后自行移除。

## 素材与许可

项目源代码采用 MIT License。

Android 图标、启动图、截图、图片、录音、音效及其他非代码素材不自动适用 MIT License，也不因仓库公开而授予单独提取、再分发或商业使用许可。如需复用这些素材，请先确认对应素材的生成或授权条款并取得必要许可。

发布前应确认所有素材的生成平台、账号套餐和使用场景均允许公开分发，并检查素材是否与现有商标、角色、音乐或其他受保护内容构成实质相似。避免使用来源不明或未经授权的图片、音乐和录音。

本项目为个人实验性演示项目，主要用于功能验证与技术练习，不保证长期迭代维护，仅供学习参考使用。