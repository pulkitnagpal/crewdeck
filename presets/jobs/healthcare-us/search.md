---
tags: jobs
# Preset: healthcare-us. Clinical and healthcare roles in the United States: state-level places, hourly pay, licences.
# Setup with Claude keeps the titles that are yours and asks for your states and licences.
roles:
  titles: [registered nurse, RN, licensed practical nurse, LPN, nurse practitioner, case manager, care coordinator, medical assistant]
  seniority_prefer: []
  exclude_title_words: [intern, director]
workplace: [onsite, hybrid, remote]   # telehealth and remote case management count as remote
places:
  onsite: []                 # cities you can work in on site, e.g. "Springfield, IL"
  remote_from: []            # the states you are licensed in and can work from, e.g. [Texas, Arizona]
  commute_km: 40
languages: [{ name: English, level: native }]
employment_types: [full-time, part-time, per-diem, contract]
licenses: []                 # e.g. ["RN (Texas)", Nurse Licensure Compact, BLS]; the judge checks what postings require
needs_sponsorship: false
exclude:
  companies: []
  industries: []
  travel: frequent           # travel-nurse contracts count as frequent travel
pay:
  currency: USD
  floor: 0                   # your hourly minimum in USD; 0 = no floor
  period: hour
  rule: bottom_of_range      # hourly ranges: the bottom must reach your floor
  unlisted: keep
  locale: en-US
  fx: {}
schedule: { timezone: "", daily_picks: 4, cooldown_days: 45 }
judge_notes: "Say which shifts suit me (days, nights, weekends) and whether bedside roles are fine."
---
# Job search

## Changes
