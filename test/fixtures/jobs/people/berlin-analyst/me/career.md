---
tags: me
resume: { file_name: "{first_name} {last_name} Lebenslauf.pdf", paper: A4, max_pages: 2 }
sections:                  # page order
  - { id: summary, kind: summary }
  - { id: example-gmbh, kind: experience, title: Senior Data Analyst, org: Example GmbH, where: Berlin, dates: "2022 – now", max_bullets: 6, required: true }
  - { id: sample-ag, kind: experience, title: Data Analyst, org: Sample AG, where: Hamburg, dates: "2018 – 2022" }
  - { id: certs, kind: list, title: Certifications }
  - { id: skills, kind: skills }
  - { id: education, kind: education }
facts:
  - { id: summary.analytics, text: "Analyst with six years of experience in product and marketing analytics.", tags: [analytics] }
  - { id: example-gmbh.dashboards, text: "Built **40** dashboards used by 300 colleagues.", tags: [bi] }
  - { id: example-gmbh.forecast, text: "Cut forecast error by 18% with a new demand model.", tags: [modelling] }
  - { id: sample-ag.etl, text: "Moved nightly reporting from spreadsheets to dbt.", tags: [dbt] }
  - { id: certs.gcp, text: "Google Cloud Professional Data Engineer (2024)" }
skills: [SQL, Python, dbt, Looker, Statistics]
---
