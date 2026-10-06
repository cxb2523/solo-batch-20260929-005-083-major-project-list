'use strict';

const BEGIN_MARKER = '<!-- CATALOG BEGIN -->';
const END_MARKER = '<!-- CATALOG END -->';
const NOTE_LINE = '<!-- catalogd: managed list, edit outside the markers -->';

function splitLines(text) {
  if (text === '') return [];
  return text.split('\n');
}

function findMarkers(lines) {
  const begins = [];
  const ends = [];
  lines.forEach((line, idx) => {
    if (line.trim() === BEGIN_MARKER) begins.push(idx);
    if (line.trim() === END_MARKER) ends.push(idx);
  });
  return { begins, ends };
}

function parseBlockEntries(bodyLines) {
  const entries = [];
  const duplicates = [];
  const seen = new Set();
  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    const match = /^-\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (name === '') continue;
    if (seen.has(name)) {
      duplicates.push(name);
      continue;
    }
    seen.add(name);
    entries.push(name);
  }
  return { entries, duplicates };
}

function renderBlock(names) {
  const lines = [BEGIN_MARKER, NOTE_LINE];
  for (const name of names) {
    lines.push('- ' + name);
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}

function analyzeReadme(readmeText) {
  const warnings = [];
  const lines = splitLines(readmeText);
  const { begins, ends } = findMarkers(lines);

  let beginIdx = -1;
  let endIdx = -1;
  for (const b of begins) {
    const e = ends.find((idx) => idx > b);
    if (e !== undefined) {
      beginIdx = b;
      endIdx = e;
      break;
    }
  }

  if (begins.length + ends.length > 0 && (beginIdx === -1 || begins.length > 1 || ends.length > 1)) {
    warnings.push({
      code: 'malformed_markers',
      message: 'README catalog markers are missing or duplicated; README left untouched to preserve existing content',
    });
  }

  if (beginIdx === -1) {
    return { blockPresent: false, malformed: warnings.length > 0, readmeEntries: [], warnings, lines };
  }

  const { entries, duplicates } = parseBlockEntries(lines.slice(beginIdx + 1, endIdx));
  for (const name of duplicates) {
    warnings.push({
      code: 'readme_duplicate_entry',
      message: 'duplicate README entry ignored (first occurrence kept): ' + name,
      entry: name,
    });
  }
  return { blockPresent: true, malformed: warnings.some((w) => w.code === 'malformed_markers'), readmeEntries: entries, warnings, lines, beginIdx, endIdx };
}

function mergeReadme(readmeText, centralEntries, options) {
  const opts = options || {};
  const warnings = [];
  const analysis = analyzeReadme(readmeText);
  for (const warning of analysis.warnings) warnings.push(warning);

  const degraded = opts.degraded === true;
  const zipNames = degraded ? [] : centralEntries.map((entry) => entry.name);
  const readmeNames = analysis.readmeEntries;

  const inZip = new Set(zipNames);
  const inReadme = new Set(readmeNames);
  const zipOnly = degraded ? [] : zipNames.filter((name) => !inReadme.has(name));
  const readmeOnly = degraded ? [] : readmeNames.filter((name) => !inZip.has(name));

  const mergedNames = [];
  const mergedSeen = new Set();
  for (const name of zipNames) {
    if (!mergedSeen.has(name)) {
      mergedSeen.add(name);
      mergedNames.push(name);
    }
  }
  for (const name of readmeNames) {
    if (!mergedSeen.has(name)) {
      mergedSeen.add(name);
      mergedNames.push(name);
    }
  }

  let newText = null;
  let readmeChanged = false;

  if (!analysis.malformed) {
    const blockText = renderBlock(mergedNames);
    if (!analysis.blockPresent) {
      const base = readmeText === '' ? '' : readmeText;
      const separator = base === '' || base.endsWith('\n') ? '' : '\n';
      newText = base + separator + blockText + '\n';
      readmeChanged = true;
    } else {
      const before = analysis.lines.slice(0, analysis.beginIdx);
      const after = analysis.lines.slice(analysis.endIdx + 1);
      newText = before.concat(splitLines(blockText)).concat(after).join('\n');
      readmeChanged = newText !== readmeText;
    }
  }

  const entries = mergedNames.map((name) => ({
    name,
    inCentral: inZip.has(name),
    inReadme: inReadme.has(name),
  }));

  return {
    entries,
    warnings,
    readmeText: newText,
    readmeChanged,
    blockPresent: analysis.blockPresent,
    readmeMalformed: analysis.malformed,
    readmeEntries: readmeNames,
    centralEntries: zipNames,
    conflicts: {
      count: zipOnly.length + readmeOnly.length,
      onlyInCentral: zipOnly,
      onlyInReadme: readmeOnly,
    },
    degraded,
  };
}

function diffState(readmeText, projectEntries) {
  const analysis = analyzeReadme(readmeText);
  const projectNames = projectEntries.map((entry) => (typeof entry === 'string' ? entry : entry.name));
  const readmeNames = analysis.readmeEntries;
  const inReadme = new Set(readmeNames);
  const inProjects = new Set(projectNames);
  const onlyInProjects = projectNames.filter((name) => !inReadme.has(name));
  const onlyInReadme = readmeNames.filter((name) => !inProjects.has(name));
  return {
    projectCount: projectNames.length,
    readmeCount: readmeNames.length,
    conflicts: onlyInProjects.length + onlyInReadme.length,
    onlyInProjects,
    onlyInReadme,
    blockPresent: analysis.blockPresent,
    readmeMalformed: analysis.malformed,
    warnings: analysis.warnings,
  };
}

module.exports = {
  mergeReadme,
  analyzeReadme,
  diffState,
  renderBlock,
  BEGIN_MARKER,
  END_MARKER,
};