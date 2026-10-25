// Which Python to run the scripts under test. macOS and Linux ship `python3`;
// Windows (including GitHub's windows-latest runners) only puts `python` on
// PATH. Set JARVIS_PYTHON to override on machines that need it.
export const PYTHON = process.env.JARVIS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
