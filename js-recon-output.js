export function parseSecretFinderOutput(output, url) {
  const findings = [];
  let currentFinding;
  const saveCurrentFinding = () => {
    if (currentFinding?.name && currentFinding.value) {
      findings.push({
        name: currentFinding.name,
        matches: [currentFinding.value.trim()],
        url,
        source: 'SecretFinder'
      });
    }
    currentFinding = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('\t->\t');
    if (separator >= 0) {
      saveCurrentFinding();
      currentFinding = {
        name: line.slice(0, separator).trim(),
        value: line.slice(separator + 4).trim()
      };
    } else if (currentFinding && line.trim()) {
      currentFinding.value += `\n${line.trim()}`;
    }
  }
  saveCurrentFinding();
  return findings;
}

export function parseLinkFinderOutput(output, url) {
  const endpoints = output.split(/\r?\n/)
    .map((line) => line.trim().replace(/&amp;/g, '&').replace(/&#x27;/g, "'"))
    .filter(Boolean);
  return [...new Set(endpoints)]
    .map((endpoint) => ({ endpoint, url, source: 'LinkFinder' }));
}