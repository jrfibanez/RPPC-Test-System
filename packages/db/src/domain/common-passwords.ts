// A small offline breach list so the §8.1 check works without network access. In production, replace or extend this
// with the HIBP Pwned Passwords k-anonymity range API or a downloaded list (only the first 5 hex chars of SHA-1 leave the server).
export const COMMON_PASSWORDS = new Set<string>([
  '123456789012', 'password1234', 'password12345', 'passwordpassword', 'qwertyuiop12', 'qwerty123456', '1234567890ab',
  'iloveyou1234', 'administrator', 'welcome12345', 'letmein12345', 'abcdefghijkl', 'aaaaaaaaaaaa', '111111111111',
  'changeme1234', 'p@ssw0rd1234', 'password@123', 'qwertyuiopas', 'football1234', 'monkey123456', 'sunshine1234',
  'princess1234', 'trustno11234', 'masterkey123', 'superman1234', 'pilipinas123', 'mabuhay12345', 'manila123456',
]);
