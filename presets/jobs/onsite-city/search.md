---
tags: jobs
# Preset: onsite-city. On-site or hybrid work in and around your city. Setup with Claude fills in the titles and the city.
roles:
  targets: []                # one per kind of job, e.g. - { name: Barista, titles: [barista, coffee shop assistant] }
  titles: []
  seniority_prefer: []
  exclude_title_words: [intern, internship]
workplace: [onsite, hybrid]  # add remote if you also want remote roles
places:
  onsite: []                 # your city (and nearby ones), "Town, Country" for small towns
  remote_from: []
  commute_km: 40             # how far from those cities a workplace may be
languages: []                # the local language matters for on-site roles: e.g. [{ name: German, level: conversational }]
employment_types: [full-time]
licenses: []
needs_sponsorship: false
exclude:
  companies: []
  industries: []
  travel: frequent
pay:
  currency: ""
  floor: 0
  period: year
  rule: top_of_range
  unlisted: keep
  fx: {}
schedule: { timezone: "", daily_picks: 5, cooldown_days: 60 }
judge_notes: ""
---
# Job search

## Changes
