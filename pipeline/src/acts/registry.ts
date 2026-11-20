import type {ActComponent} from './types';
import {Act01} from './Act01';
import {Act02} from './Act02';
import {Act03} from './Act03';
import {Act04} from './Act04';
import {Act05} from './Act05';
import {Act06} from './Act06';
import {Act07} from './Act07';

/**
 * transitionIn：'iris' = 由 Episode 套用「資料點」收合／展開轉場（上一幕結尾收成點，本幕由點展開）；
 *               'self' = 本幕自行處理進場（上一幕也不收合）。
 */
export const ACTS: {id: string; component: ActComponent; transitionIn: 'iris' | 'self'}[] = [
  {id: 'act01', component: Act01, transitionIn: 'self'},
  {id: 'act02', component: Act02, transitionIn: 'iris'},
  {id: 'act03', component: Act03, transitionIn: 'iris'},
  {id: 'act04', component: Act04, transitionIn: 'iris'},
  {id: 'act05', component: Act05, transitionIn: 'iris'},
  {id: 'act06', component: Act06, transitionIn: 'iris'},
  {id: 'act07', component: Act07, transitionIn: 'iris'},
];
