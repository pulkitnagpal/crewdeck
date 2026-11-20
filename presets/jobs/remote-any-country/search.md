---
tags: jobs
# Preset: remote-any-country. Remote work from wherever you live. Setup with Claude fills in the titles and places;
# change anything here, on the Jobs page, or by telling Claude (it runs `crewdeck jobs pref set …`).
roles:
  targets: []                # one per kind of job, e.g. - { name: Customer success, titles: [customer success manager, account manager] }
  titles: []
  seniority_prefer: []       # ordering, not a filter, e.g. [senior, lead]
  exclude_title_words: [intern, internship]
workplace: [remote]          # remote | hybrid | onsite
places:
  onsite: []                 # cities for on-site or hybrid work, if you also want those
  remote_from: []            # the countries, regions or states you can work remotely from; worldwide = anywhere
  commute_km: 50
languages: []                # e.g. [{ name: English, level: fluent }]; basic | conversational | professional | fluent | native
employment_types: [full-time, contract]   # full-time | part-time | contract | per-diem | internship | temporary
licenses: []
needs_sponsorship: false
exclude:
  companies: []
  industries: []
  travel: frequent           # the lowest travel that rules a job out: none | occasional | frequent
pay:
  currency: ""               # your currency code, e.g. EUR, USD, INR
  floor: 0                   # your minimum in that currency per period; 0 = no floor
  period: year               # year | month | hour
  rule: top_of_range
  unlisted: keep
  fx: {}                     # 1 unit of another currency in yours, e.g. { USD: 0.92 }: remote postings often pay in USD
schedule: { timezone: "", daily_picks: 5, cooldown_days: 60 }
judge_notes: "Remote roles must be open to people living where I live: a posting limited to other countries is a no."
---
# Job search

## Changes
