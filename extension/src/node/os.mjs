// No home folder in the extension: paths under it never match anything.
const os = { homedir: () => '/nonexistent-home', hostname: () => 'chrome', platform: () => 'chrome-extension' };
export default os;
