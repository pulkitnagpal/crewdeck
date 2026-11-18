---
tags: jobs
# What you want. Change it here, on the Jobs page, or by telling Claude (it runs `crewdeck jobs pref set …`).
roles:
  titles: []                 # a job title must contain one of these, e.g. [data analyst, analytics engineer]
  seniority_prefer: []       # ordering, not a filter, e.g. [senior, lead]
  exclude_title_words: []    # whole words, e.g. [intern, internship, sales]
workplace: []                # remote | hybrid | onsite
places:
  onsite: []                 # cities you can work in on-site or hybrid ("Town, Country" for small towns)
  remote_from: []            # countries, regions or states you can work remotely from; worldwide = anywhere
  commute_km: 50             # how far from those cities a workplace may be
languages: []                # e.g. [{ name: English, level: fluent }]; basic | conversational | professional | fluent | native
employment_types: []         # full-time | part-time | contract | per-diem | internship | temporary
licenses: []                 # e.g. "RN (Texas)"; the judge checks what postings require
needs_sponsorship: false
exclude:
  companies: []
  industries: []             # e.g. [gambling, crypto]
  travel: none               # the lowest travel that rules a job out: none | occasional | frequent
pay:
  currency: ""               # your currency code, e.g. EUR, USD, INR
  floor: 0                   # your minimum in that currency per period; 0 = no floor
  period: year               # year | month | hour
  rule: top_of_range         # top_of_range: keep if the top reaches the floor; bottom_of_range: the bottom must
  unlisted: keep             # keep | drop postings that show no pay
  fx: {}                     # 1 unit of another currency in yours, e.g. { USD: 0.92 }
schedule: { timezone: "", daily_picks: 5, cooldown_days: 60 }
judge_notes: ""              # anything else, in your words, for the judging step
---
# Job search

## Changes
