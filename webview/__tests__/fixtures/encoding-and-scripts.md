# Encoding, whitespace, and complex scripts

Two trailing spaces are a hard break, and so is a trailing backslash. Both  
spellings appear in real files, and each must come back the way it went in.\
This line follows the backslash spelling.

A single trailing space is not a break, just a habit some editors leave behind. 
It belongs to the line it sits on.

Non-ASCII punctuation is content: “curly quotes”, ‘single curlies’, an em—dash,
an en–dash, an ellipsis…, a prime ′, and a non-breaking space between these
words. A narrow no-break space sits here: 12 345 kr.

A zero-width joiner sequence must survive as one grapheme: 👩‍💻 and 🏳️‍🌈.

A hard tab inside prose:	after the tab. Hard tabs inside table cells are
content rather than indentation:

| key	name | value	two |
| --- | --- |
| a	b | c	d |

Right-to-left text, with Latin and emphasis mixed in:

مرحبا **بالعالم** — this sentence starts in Arabic and ends in English.

שלום *עולם* — and this one starts in Hebrew.

- פָּרָשָׁה with combining niqqud in a list item
- देवनागरी with combining matras
- ภาษาไทยไม่มีการเว้นวรรคระหว่างคำ — Thai has no inter-word spaces
- 한글 자모 결합 and 日本語のルビなし本文

An explicit bidi isolate around a mixed run: ⁦DIR-123 مرحبا⁩ ends here.

Combining marks that are NOT precomposed: é and ä stay decomposed.
