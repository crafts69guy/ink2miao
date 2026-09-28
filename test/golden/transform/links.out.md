---
inkdrop:
  id: note:self
  title: "Original: title"
  notebook: Projects/Child
  tags:
    - alpha
    - zeta
  status: active
  pinned: true
  created: 2024-01-15T08:30:00.123Z
  updated: 2024-01-16T08:30:00.123Z
---

# Links

Same text: [[Alpha]] and legacy [[Alpha]].
Custom text: [**the** alpha note](miaoyan://goto/Alpha "title kept").
Fragment: [Alpha](miaoyan://goto/Alpha).
Slash title: [[Beta/Gamma]].
Unsafe title: [Weird [x]](miaoyan://goto/Weird%20%5Bx%5D).
Angle: [x](<miaoyan://goto/Alpha>)
Missing: [gone](inkdrop://note/nope).
Reference: [alpha][r]

[r]: miaoyan://goto/Alpha
<miaoyan://goto/Beta%2FGamma>
Bare text inkdrop://note/a stays and is reported.
Unknown scheme: [x](inkdrop://book/abc)
Existing wiki: [[Alpha]]

<!-- unresolved: [{"kind":"note","raw":"inkdrop://note/nope"},{"kind":"scheme","raw":"inkdrop://book/abc"},{"kind":"bare","raw":"inkdrop://note/a"}] -->
