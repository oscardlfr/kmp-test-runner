#!/usr/bin/env python3
"""
Shared coverage XML parser for Kover and JaCoCo reports.

Both tools produce JaCoCo-compatible XML with <package>, <class>, <counter type="LINE">,
and <sourcefile> elements. This parser reads only the shared subset, producing identical
output regardless of which tool generated the XML.

Usage:
  python3 parse-coverage-xml.py <xml_path> <module_name> [--mode report|gaps] [--output-file path]

Mode "report" (default): pipe-delimited class records
  module|package|sourcefile|classname|covered|missed|total|pct|missed_lines

Mode "gaps": pipe-delimited gap records (for ai-error-extractor)
  sourcefile|package|missed|total|pct|missed_ranges
"""

import sys
import xml.etree.ElementTree as ET

EXCLUSIONS = ['$DefaultImpls', '$Companion', '$$serializer', 'ComposableSingletons$']


def is_excluded(class_name):
    for ex in EXCLUSIONS:
        if ex in class_name:
            return True
    return False


def format_ranges(lines):
    """Convert sorted list of line numbers into compact range strings."""
    if not lines:
        return ''
    ranges = []
    start = end = lines[0]
    for n in lines[1:]:
        if n == end + 1:
            end = n
        else:
            ranges.append(f'{start}' if start == end else f'{start}-{end}')
            start = end = n
    ranges.append(f'{start}' if start == end else f'{start}-{end}')
    return ', '.join(ranges)


def parse_report_mode(root, module_name):
    """Output one pipe-delimited record per source file (aggregating all inner/synthetic classes).

    JaCoCo emits one <class> per JVM class, so Kotlin sealed/enum/data classes with inner
    variants (AesAlgorithm$Cbc, AesAlgorithm$Ecb, ...) all reference the same sourcefilename.
    Emitting one row per <class> causes duplicate line numbers and inflated class counts.

    Instead we aggregate at the <sourcefile> level: one record per .kt file, using the
    LINE counter from the <sourcefile> element which already reflects the merged totals.
    """
    results = []
    for package in root.findall('package'):
        pkg_name = package.get('name', '')

        for sf in package.findall('sourcefile'):
            source_file = sf.get('name', '')
            if not source_file:
                continue

            # Use the LINE counter from the sourcefile element (authoritative aggregate)
            line_counter = None
            for counter in sf.findall('counter'):
                if counter.get('type') == 'LINE':
                    line_counter = counter
                    break
            if line_counter is None:
                continue

            missed = int(line_counter.get('missed', '0'))
            covered = int(line_counter.get('covered', '0'))
            total = missed + covered
            if total == 0:
                continue
            pct = round((covered / total) * 100, 1)

            # Missed lines: lines where mi>0 in the sourcefile's <line> elements
            missed_lines = []
            for line in sf.findall('line'):
                if int(line.get('mi', '0')) > 0:
                    missed_lines.append(int(line.get('nr', '0')))
            missed_lines.sort()
            missed_lines_str = ','.join(str(x) for x in missed_lines)

            # Display name: strip .kt extension for readability
            display_name = source_file[:-3] if source_file.endswith('.kt') else source_file

            results.append(
                f"{module_name}|{pkg_name}|{source_file}|{display_name}|{covered}|{missed}|{total}|{pct}|{missed_lines_str}"
            )
    return results


def parse_gaps_mode(root):
    """Output pipe-delimited gap records for ai-error-extractor."""
    gaps = []

    for package in root.findall('package'):
        pkg_name = package.get('name', '').replace('/', '.')
        for sourcefile in package.findall('sourcefile'):
            fname = sourcefile.get('name', '')
            line_counter = None
            for counter in sourcefile.findall('counter'):
                if counter.get('type') == 'LINE':
                    line_counter = counter
                    break

            if line_counter is None:
                continue
            missed = int(line_counter.get('missed', '0'))
            covered = int(line_counter.get('covered', '0'))
            total = missed + covered
            if missed == 0 or total == 0:
                continue

            percentage = round((covered / total) * 100, 1)

            missed_lines = []
            for line_elem in sorted(sourcefile.findall('line'), key=lambda l: int(l.get('nr', '0'))):
                mi = int(line_elem.get('mi', '0'))
                ci = int(line_elem.get('ci', '0'))
                if mi > 0 and ci == 0:
                    missed_lines.append(int(line_elem.get('nr', '0')))

            missed_ranges = format_ranges(missed_lines)
            gaps.append((missed, fname, pkg_name, total, percentage, missed_ranges))

    # Sort by missed lines descending
    gaps.sort(key=lambda x: -x[0])

    results = []
    for missed, fname, pkg_name, total, pct, ranges in gaps:
        results.append(f'{fname}|{pkg_name}|{missed}|{total}|{pct}|{ranges}')
    return results


def main():
    if len(sys.argv) < 3:
        print("Usage: parse-coverage-xml.py <xml_path> <module_name> [--mode report|gaps] [--output-file path]",
              file=sys.stderr)
        sys.exit(1)

    xml_path = sys.argv[1]
    module_name = sys.argv[2]
    mode = 'report'
    output_file = None

    i = 3
    while i < len(sys.argv):
        if sys.argv[i] == '--mode' and i + 1 < len(sys.argv):
            mode = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--output-file' and i + 1 < len(sys.argv):
            output_file = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except Exception:
        sys.exit(0)

    if mode == 'gaps':
        results = parse_gaps_mode(root)
    else:
        results = parse_report_mode(root, module_name)

    output = '\n'.join(results)
    if output_file:
        with open(output_file, 'w') as f:
            f.write(output)
            if output:
                f.write('\n')
        # Print count for gaps mode (backwards compat with ai-error-extractor)
        if mode == 'gaps':
            print(len(results))
    else:
        if output:
            print(output)
        # Print count for gaps mode
        if mode == 'gaps' and not output_file:
            pass  # count already implicit in output


if __name__ == '__main__':
    main()
