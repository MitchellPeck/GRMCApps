export const VOICE = "GRMC voice rules: short, punchy, warm but not stiff. Salutations ('Family of Grace', 'Hey everyone') should be used sparingly, and rarely on content for both members and guests. Salutations are acceptible on posts that are more towards members. Open as an invitation, not insider communication. 2-4 sentences, line breaks between thoughts. No hashtags unless natural. Sentence case. No em-dashes as decoration.";

export interface HistoryPost { date: string; phase: string; title: string; sub: string; }

export const HISTORY_SERIES_POSTS: HistoryPost[] = [
  {date:"Jun 9",  phase:"Phase 1 - Our roots",          title:"Where it all began",        sub:"Founding in 2022 by ministers who came out of retirement - Randy Mickler, Charlie Marus, Ted Sauter - the East Cobb neighborhood, the original vision"},
  {date:"Jun 16", phase:"",                               title:"The people who built this",  sub:"The founding ministerial team - their combined decades of ministry across the Southeast and why they chose to start something new"},
  {date:"Jun 23", phase:"",                               title:"The building has a story",   sub:"History of the physical church at 1200 Indian Hills Pkwy - what it has meant to the East Cobb community"},
  {date:"Jun 30", phase:"",                               title:"A neighborhood, a calling",  sub:"East Cobb and Marietta - the community GRMC was planted to serve and the values that shaped its location"},
  {date:"Jul 7",  phase:"",                               title:"Through the early years",    sub:"What it took to establish a new congregation - growth, challenges, and the people who showed up from the start"},
  {date:"Jul 14", phase:"",                               title:"A mission in three words",   sub:"Honor God. Proclaim Christ. Serve others. Unpacking GRMC core mission and how it plays out week to week"},
  {date:"Jul 21", phase:"Phase 2 - Who we are now",      title:"Grace today",                sub:"Snapshot of GRMC right now - congregation, ministries, Sunday worship at 11am, what makes it distinct"},
  {date:"Jul 28", phase:"",                               title:"Our people, our story",      sub:"Spotlight: longtime members who embody the spirit of Grace Resurrection"},
  {date:"Aug 4",  phase:"",                               title:"Where worship happens",      sub:"A/V, music, production - the behind-the-scenes team that makes Sunday happen every week"},
  {date:"Aug 11", phase:"",                               title:"Serving beyond these walls", sub:"Outreach, missions, community partnerships - GRMC in Cobb County and beyond"},
  {date:"Aug 18", phase:"",                               title:"Every generation matters",   sub:"Youth, children ministry, young adults - multigenerational vision and NextGen leadership under Rev. Bacon"},
  {date:"Aug 25", phase:"Phase 3 - Where we are headed", title:"A vision for Grace",         sub:"Rev. Williams on where God is calling GRMC next - growth, discipleship, presence in East Cobb"},
  {date:"Sep 1",  phase:"",                               title:"You are part of this story", sub:"Invitation - the future of GRMC is still being written, and it includes you"}
];
