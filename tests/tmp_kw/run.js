const { extractKeywords } = require('./kw.js')

const cases = [
  {
    name: 'Huckel',
    text: "Hückel's rule is used to identify aromatic molecules, and states that such a compound must have (4n + 2) pi electrons.",
  },
  {
    name: 'ACE-ARB preload/afterload',
    text: 'ACE inhibitors and ARBs {{c1::decrease}} both preload and afterload',
  },
  {
    name: 'Finasteride',
    text: 'Finasteride treats androgenetic alopecia by inhibiting types II and III 5α-reductase.',
  },
  {
    name: 'AIS',
    text: 'In androgen insensitivity syndrome a person is genotypically XY but has female external genitalia, present undescended testes, and breasts',
  },
  {
    name: 'Include',
    text: 'Two main side effects of osmotic laxatives include diarrhea, nausea, and dehydration',
  },
  {
    name: 'Cheyne-Stokes',
    text: 'Cheyne-Stokes breathing is defined by respirations that oscillate between apnea and hyperpnea',
  },
  {
    name: 'Minoxidil',
    text: 'Only minoxidil and finasteride are FDA approved for the treatment of androgenetic alopecia in males',
  },
  {
    name: 'Cushing',
    text: 'What classes of steroid hormones are increased in Cushing syndrome/disease? Glucocorticoids (cortisol) ± androgens',
  },
  {
    name: 'Beta-oxidation',
    text: '{{c1::Beta-oxidation}} regenerates {{c3::acetyl-CoA}} for use as an energy source in {{c2::peripheral tissues}} by breaking down {{c4::fatty acids}}.',
  }
]

for (const c of cases) {
  console.log('---', c.name, '---')
  console.log(extractKeywords(c.text, 10))
}
