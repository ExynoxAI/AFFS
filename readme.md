# 🚀 AFFS - Auto Form Fill System

> **Smart Chrome Extension for Automated Form Filling**

Automatically fills exam submission forms with intelligent form detection and submission automation. Built for efficiency and ease of use.

[![GitHub Release](https://img.shields.io/github/v/release/ExynoxAI/AFFS?style=flat-square)](https://github.com/ExynoxAI/AFFS/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-informational?style=flat-square&logo=google-chrome)](https://chrome.google.com/webstore)

<video href='https://cs37.clideo.com/p/JMvWLWe6s2fmegb5TIzD-Q/8890e0a993227d4ab8297fc46038f33f/clideo_editor_eba6e3e42abf46eaa8ba90198fd13d75.mp4'></video>
---

## ✨ Features

- ⚡ **Auto-Detection**: Automatically detects Mid-Term and End-Semester exam pages
- 🎯 **Smart Form Filling**: Intelligently fills form fields with biased random values
- 🔄 **Continuous Submission**: Automatically submits forms and continues until completion
- 📋 **Subject Handling**: Automatically selects and processes all available subjects
- 🎨 **Modern UI**: Clean, intuitive interface with Tailwind CSS
- 📱 **Real-time Status**: Live feedback on automation progress
- 🛡️ **Safe & Reliable**: Includes error handling and retry logic
- 📝 **Console Logging**: Detailed debug information for troubleshooting

---

## 📦 Installation

### **Quick Start (3 Steps)**

#### **Step 1: Download the Extension**

Download the latest source code from the releases page:
- 📥 [Download AFFS v1.0.0 (ZIP)](
https://raw.githubusercontent.com/ExynoxAI/AFFS/refs/heads/main/AFFS-Release.v1.zip)

Or clone from GitHub:
```bash
git clone https://github.com/ExynoxAI/AFFS.git
cd AFFS
```

#### **Step 2: Unzip the Archive**

**On Windows:**
```powershell
# Right-click the ZIP file → Extract All
# Or use PowerShell:
Expand-Archive -Path AFFS-v1.0.0.zip -DestinationPath AFFS
cd AFFS
```

**On Mac/Linux:**
```bash
unzip AFFS-v1.0.0.zip
cd AFFS
```

#### **Step 3: Load in Chrome**

1. **Open Chrome Extensions Page**
   - Type in address bar: `chrome://extensions/`
   - Or: Menu → More Tools → Extensions

2. **Enable Developer Mode**
   - Toggle the switch in the top-right corner

3. **Load Unpacked**
   - Click "Load unpacked" button
   - Navigate to the extracted `form-auto-fill-extension` folder
   - Select it and click "Open"

4. **Done! 🎉**
   - The extension is now active in Chrome
   - Look for the extension icon in the top-right corner

---

## 🚀 How to Use

### **Automatic Mode (Default)**
1. Navigate to `http://192.168.1.201:8080/`
2. The extension **automatically starts** after 2 seconds
3. Watch the console (F12) for progress
4. Automation continues until "Completed!" dialog appears

### **Manual Mode**
1. Click the extension icon in the top-right corner
2. Click **"▶ Start"** to manually trigger the script
3. Click **"⏹ Stop"** to pause execution
4. Status updates in real-time

### **Monitor Progress**
- Open DevTools: **F12**
- Go to **Console** tab
- Watch detailed logs:
  ```
  HyperDyn / Skandan V Combined Auto-Fill Script Started
  ✓ Correct URL detected
  Detected Mid-Term Page. Starting automation...
  Selected subject: Mathematics
  Input k:q1: set to 3
  Form submitted.
  ```

---

## 📋 Requirements

- ✓ **Chrome Browser** (v90+)
- ✓ **Windows/Mac/Linux**
- ✓ **Target URL**: `http://192.168.1.201:8080/`
- ✓ **JavaScript Enabled** in Chrome

---

## 📁 Project Structure

```
form-auto-fill-extension/
├── manifest.json          # Chrome extension manifest (MV3)
├── content.js             # Main auto-fill script
├── popup.html             # Popup UI with Tailwind CSS
├── popup.js               # Popup controller logic
├── background.js          # Background service worker
├── README.md              # Feature documentation
└── images/                # (Optional) Extension icons
```

---

## 🔧 Configuration

### **Auto-Start Delay**
Edit `content.js` line ~52:
```javascript
const autoStartDelay = setTimeout(() => {
  // Change 2000 to desired milliseconds
}, 2000); // Default: 2 seconds
```

### **Form Selectors**
Customize form element detection in `content.js`:
```javascript
const midTermInputs = document.querySelectorAll('input[id^="k:q"]');
const endSemInputs = document.querySelectorAll('input[id^="k:aq"], input[id^="k:bq"], input[id^="k:cq"]');
```

### **Random Value Range**
Modify `biasedRandom()` in `content.js`:
```javascript
function biasedRandom() {
  // Currently returns 1-5 with bias towards lower numbers
  // Customize the range and probabilities as needed
}
```

---

## 🛠️ Troubleshooting

### **Extension Not Showing?**
```powershell
# 1. Reload the page
# 2. Check chrome://extensions/ - ensure it's enabled
# 3. Verify you're on correct URL: 192.168.1.201:8080
```

### **Script Not Running?**
```javascript
// Open DevTools (F12) → Console
// Should show: "HyperDyn / Skandan V Combined Auto-Fill Script Loaded"
// If not, check for JavaScript errors
```

### **Wrong URL Error?**
- The extension only works on `http://192.168.1.201:8080/`
- Ensure you navigate to this exact URL
- Check the popup - it should show "✓ Ready on correct URL"

### **Still Having Issues?**
1. Open DevTools Console (F12)
2. Check Service Worker logs: `chrome://extensions/` → Service Worker (under extension name)
3. Look for error messages
4. Try refreshing the page
5. Remove and re-load the extension

---

## 📊 Technical Details

### **Auto-Fill Logic**

1. **Page Detection**
   - Checks for Mid-Term input fields (`k:q*`)
   - Checks for End-Semester input fields (`k:aq*`, `k:bq*`, `k:cq*`)

2. **Subject Selection**
   - Opens dropdown menu
   - Selects first available subject
   - Waits for UI to update

3. **Form Filling**
   - Finds all input fields with matching selector
   - Fills each with biased random value (1-5)
   - Triggers `input` event for validation

4. **Form Submission**
   - Scrolls to submit button
   - Clicks the button
   - Waits for page response

5. **Completion Detection**
   - Checks for dialog: `#primefacesmessagedlg`
   - Verifies "Completed!" text is visible
   - Stops automation on success

### **Timing & Delays**
- **Action Delay**: 400-900ms between actions
- **Wait Between Actions**: 600-1200ms
- **Wait Between Subjects**: 2000-4000ms
- **Page Load Wait**: 1000-2000ms

---

## 🔐 Privacy & Security

- ✓ **No Data Collection**: Extension doesn't collect any user data
- ✓ **Local Only**: All processing happens locally in the browser
- ✓ **No Network Calls**: Doesn't send data to external servers
- ✓ **Open Source**: Full source code visible for inspection
- ✓ **Permissions Limited**: Only runs on specified URL

---

## 📝 License

MIT License - Feel free to use, modify, and distribute

---

## 👨‍💻 Developer Credits

**Created by:** [HyperDyn](https://www.hyperdyn.tech)
**Team:** Skandan V + HyperDyn AI Team

### **Contributors**
- 🎯 Core Automation Logic: Skandan V
- 🎨 UI/UX Design: HyperDyn Team
- 🔧 Engineering & Optimization: HyperDyn Team

### **Special Thanks**
- Chrome Extension Community
- Open Source Contributors

---

## 🌐 Links

- 🌍 **Website**: [www.hyperdyn.tech](https://www.hyperdyn.tech)
- 📦 **GitHub**: [ExynoxAI/AFFS](https://github.com/ExynoxAI/AFFS)
- 📥 **Latest Release**: [v1.0.0](https://github.com/ExynoxAI/AFFS/releases/tag/v1)
- 📧 **Contact**: [HyperDyn](https://www.hyperdyn.tech)

---

## 📢 Version History

### **v1.0.0** - November 2025
- ✨ Initial Release
- ⚡ Auto-fill automation for exam forms
- 🎨 Modern UI with Tailwind CSS
- 🔄 Auto-start functionality
- 📝 Comprehensive logging
- 🛡️ Error handling & retry logic

---

## ⚡ Quick Commands

### **Clone Repository**
```bash
git clone https://github.com/ExynoxAI/AFFS.git
cd AFFS/form-auto-fill-extension
```

### **Load in Chrome**
```powershell
# Open Chrome extensions
start "chrome://extensions/"

# Then manually load unpacked
```

### **View Logs**
```javascript
// In any tab on the target URL, open DevTools (F12)
// Console will show all automation logs
```

---

## 🐛 Report Issues

Found a bug? Have a suggestion?
- 📝 [Create an Issue](https://github.com/ExynoxAI/AFFS/issues)
- 💬 [Start a Discussion](https://github.com/ExynoxAI/AFFS/discussions)
- 📧 Contact: [www.hyperdyn.tech](https://www.hyperdyn.tech)

---

## 📄 Additional Resources

- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Guide](https://developer.chrome.com/docs/extensions/mv3/)
- [Content Scripts Guide](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)

---

## 🎯 Roadmap

Future enhancements:
- [ ] Settings panel for customization
- [ ] Multiple URL support
- [ ] Export/Import configurations
- [ ] Advanced scheduling options
- [ ] Chrome Web Store submission
- [ ] User analytics & statistics

---

**Made with ❤️ by [Hyperdyn](https://www.hyperdyn.tech)**

**Version 1.0.0 | Last Updated: November 2025**

---

## 📞 Support

For issues, questions, or suggestions:
1. Check the [GitHub Issues](https://github.com/ExynoxAI/AFFS/issues)
2. Visit [www.hyperdyn.tech](https://www.hyperdyn.tech)
3. Review the [Troubleshooting](#-troubleshooting) section above

**Happy Automating! 🚀**
