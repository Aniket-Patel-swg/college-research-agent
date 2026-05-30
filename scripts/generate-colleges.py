#!/usr/bin/env python3
"""Generate src/colleges.ts from ACPC CSV (same names as college-predictor)."""
from __future__ import annotations

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV = ROOT.parents[1] / "admissions-predictoins/college-predictor/data/acpc_last_admitted_all_years.csv"
OUT = ROOT / "src/colleges.ts"
FRONTEND_OUT = ROOT.parent / "admission-buddy-frontend/app/lib/colleges.ts"

FEATURED_CODES = {"40", "81", "93", "164"}

# Truncated / typo / duplicate Inst_Code rows — map to the canonical entry kept in COLLEGES.
INST_CODE_ALIASES: dict[str, str] = {
    "2": "3",    # ADANI … AHMED ABAD → AHMEDABAD
    "4": "5",    # ADANI AU-FEST truncated
    "6": "7",    # ADITYA SILVER OAK truncated
    "36": "37",  # Darshan Rajkot- Morbi → Rajkot-Morbi
    "45": "46",  # Engginering → Engineering College, Tuwa
    "100": "101",  # Mahatma Gandhi duplicate
    "102": "103",  # Mahavir Bharthana- Vesu → Bharthana-Vesu
    "104": "106",  # Marwadi Faculty Of Engg. → canonical Marwadi name
    "105": "106",  # Marwadi Faculty Of Tech. → canonical Marwadi name
    "159": "158",  # VEERAYATAN shorter name → full name
    "163": "164",  # VGEC Gandhina gar typo → Gandhinagar
}

EXCLUDED_INST_CODES = set(INST_CODE_ALIASES.keys())


def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def main() -> None:
    by_code: dict[str, str] = {}
    with CSV.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            code = row["Inst_Code"].strip()
            name = row["Inst_Name"].strip()
            if code not in by_code or len(name) > len(by_code[code]):
                by_code[code] = name

    lines = [
        "/** Auto-generated from acpc_last_admitted_all_years.csv — run scripts/generate-colleges.py to refresh. */",
        "",
        "export const COLLEGES = [",
    ]
    kept = 0
    for code in sorted(by_code, key=lambda x: int(x)):
        if code in EXCLUDED_INST_CODES:
            continue
        name = by_code[code]
        feat = ", featured: true" if code in FEATURED_CODES else ""
        lines.append(f'  {{ instCode: "{code}", name: "{esc(name)}"{feat} }},')
        kept += 1
    lines += [
        "] as const;",
        "",
        'export type CollegeName = (typeof COLLEGES)[number]["name"];',
        "",
        "export type CollegeEntry = {",
        "  instCode: string;",
        "  name: CollegeName;",
        "  featured?: boolean;",
        "};",
        "",
        "export const COLLEGE_NAMES: readonly CollegeName[] = COLLEGES.map((c) => c.name);",
        "",
        "const COLLEGE_NAME_SET = new Set<string>(COLLEGE_NAMES as readonly string[]);",
        "const COLLEGE_BY_CODE = new Map<string, CollegeEntry>(",
        "  COLLEGES.map((c) => [c.instCode, c as CollegeEntry]),",
        ");",
        "",
        "/** Duplicate/truncated CSV Inst_Code → canonical Inst_Code kept in COLLEGES. */",
        "const INST_CODE_ALIASES: Record<string, string> = {",
    ]
    for src, dst in sorted(INST_CODE_ALIASES.items(), key=lambda x: int(x[0])):
        lines.append(f'  "{src}": "{dst}",')
    lines += [
        "};",
        "",
        "export function isCollegeName(name: string): name is CollegeName {",
        "  return COLLEGE_NAME_SET.has(name);",
        "}",
        "",
        "export function collegeByInstCode(instCode: string): CollegeEntry | undefined {",
        "  const canonical = INST_CODE_ALIASES[instCode] ?? instCode;",
        "  return COLLEGE_BY_CODE.get(canonical);",
        "}",
        "",
        "export function collegeByName(name: string): CollegeEntry | undefined {",
        "  if (!isCollegeName(name)) return undefined;",
        "  return COLLEGES.find((c) => c.name === name);",
        "}",
        "",
        "export function featuredColleges(): CollegeEntry[] {",
        "  return (COLLEGES as readonly CollegeEntry[]).filter((c) => c.featured);",
        "}",
        "",
        "export function collegeDetailsHref(nameOrEntry: string | CollegeEntry): string | null {",
        "  const entry =",
        '    typeof nameOrEntry === "string" ? collegeByName(nameOrEntry) : nameOrEntry;',
        "  if (!entry) return null;",
        "  return `/college/${entry.instCode}`;",
        "}",
        "",
    ]
    body = "\n".join(lines) + "\n"
    OUT.write_text(body, encoding="utf-8")
    FRONTEND_OUT.write_text(body, encoding="utf-8")
    print(f"Wrote {kept} colleges (excluded {len(EXCLUDED_INST_CODES)} duplicates) to {OUT}")


if __name__ == "__main__":
    main()
