/** Position in the sidebar busy wave's shared 1.6s cycle, from the wall clock, so every busy dot shares one epoch. */
export const waveStart = () => Date.now() % 1600
