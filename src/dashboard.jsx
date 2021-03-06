#!/usr/bin/env node
"use strict";

import fs from 'fs';

import program from 'commander';
import {version} from '../package.json';
import proc from 'child_process';
import React, {Component} from 'react';
import blessed from 'blessed';
import {render} from 'react-blessed';


import {highlight} from 'cli-highlight';
import {StringDecoder} from 'string_decoder';
import chokidar from 'chokidar';
import Spinner from './spinner.js';
import {
    COMPOSE_PROJECT_NAME,
    APP_DIR,
    SUPER_USER,
    SUPER_USER_PASSWORD,
    DB_HOST,
    DB_NAME,
    LOG_LENGTH,
    PSQL_CMD
} from './env.js';


const DB_DIR = APP_DIR + "/db/src/";
const WATCH_PATTERNS =
        process.env.WATCH_PATTERNS
        ? process.env.WATCH_PATTERNS.split(',').map(p => APP_DIR + '/' + p)
        : [APP_DIR +'/db/src/**/*.sql', APP_DIR + '/openresty/lualib/**/*.lua', APP_DIR +'/openresty/nginx/conf/**/*.conf']
const TITLES = {
  openresty: 'OpenResty',
  postgrest: 'PostgREST',
  db: 'PostgreSQL',
  rabbitmq: 'RabbitMQ',
  pgamqpbridge: 'pg-amqp-bridge'
}

const decoder = new StringDecoder('utf8');
//Workaround for a bug in the highlighting lib
const printLog = data => highlight(decoder.write(data), {language : 'accesslog'}).replace(/<span class=\"hljs-string\">/g, '').replace(/<\/span>/g, '');
const printSQL = data => highlight(decoder.write(data), {language : 'sql'});



class Dashboard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      containers: props.containers,
      containerOrder: Object.keys(props.containers),
      activeContainer: Object.keys(props.containers)[0],
      showHelp: false,
      watcherRunning: true
    }
  }
  componentDidMount(){
    const {containers, activeContainer, containerOrder} = this.state;
    const refs = this.refs;
    const {topMenu, dashboard} = refs;

    topMenu.select(containerOrder.indexOf(activeContainer));
    dashboard.on("element keypress", (el, ch, key) => this.handleKeyPress(key.full));

    //start log tail procs
    Object.keys(containers).map(key => {
      this.startLogTail(key)
    })

    this.startWatcher();
  }
  stopWatcher = () => {
    const {activeContainer} = this.state;
    const logger = this.refs['log_'+activeContainer];
    if(this.watcher){ this.watcher.close(); this.watcher = null;}
    this.setState({watcherRunning:false});
    logger.log('Stopping watcher');
  }
  startWatcher = () => {
    const onReady = () => {
      const spinner = this.refs['watcherSpinner'];
      const logger = this.refs['log_'+this.state.activeContainer];
      spinner.stop();
      logger.log('Ready ---------------------------------------');
    }
    this.setState({watcherRunning:true});
    if(this.watcher){ this.watcher.close(); }
    this.watcher = chokidar.watch(WATCH_PATTERNS, { ignored : APP_DIR+'/**/tests/**'})
      .on('change', path => {
        const {containers} = this.state;
        const spinner = this.refs['watcherSpinner'];
        const logger = this.refs['log_'+this.state.activeContainer];
        const relPath = path.replace(APP_DIR, '.');
        logger.log(`${relPath} changed`);
        logger.log('Starting code reload ------------------------');
        spinner.start()
        if(path.endsWith('.sql')){
          this.resetDb().on('close', onReady);
        }else{
          if(containers['openresty']){
            this.sendHUP(containers['openresty'].name).on('close', onReady);
          }
          else{
            onReady();
          }
        }
      })
      .on('ready', () => {
        const logger = this.refs['log_'+this.state.activeContainer];

        logger.log('Watching ' + WATCH_PATTERNS.map(p => p.replace(APP_DIR + '/','')).join(', ') + ' for changes.');
        logger.log('in ' + APP_DIR);
      });
  }
  startLogTail = (key, timestamp) => {
    const {containers} = this.state;
    const logger = this.refs['log_'+key];
    const printer = key == 'db' ? printSQL : printLog;
    timestamp = timestamp ? timestamp : 0;
    if (containers[key].logProc) { containers[key].logProc.kill() }
    containers[key].logProc = proc.spawn('docker',['logs', '--tail', 500, '--since', timestamp, '-f', containers[key].name]);
    containers[key].logProc.stdout.on('data', data => logger.log(printer(data)));
    containers[key].logProc.stderr.on('data', data => logger.log(printer(data)));
  }
  selectContainer = (idx) => {
    const {activeContainer, containerOrder} = this.state;
    const total = containerOrder.length;
    if (isNaN(idx) || idx >= total || idx < 0 ) return;
    this.setState({activeContainer: containerOrder[idx]});
    this.refs.topMenu.select(idx);
  }
  restartContainer = (key) => {
    const container = this.state.containers[key];
    const logger = this.refs['log_'+key];
    logger.log(`Restarting ${TITLES[key]} container ...`)
    proc.spawn('docker',['restart', container.name]).on('close', (code) => {
      logger.log('Done');
      this.startLogTail(key, Math.floor(new Date() / 1000));
    });
  }
  runSql = (commands) => {
    const {activeContainer} = this.state;
    const logger = this.refs['log_'+activeContainer];
    const connectParams = ['-U', SUPER_USER, '-h', 'localhost', '--set', 'DIR='+DB_DIR, '--set', 'ON_ERROR_STOP=1']
    var env = Object.create( process.env );
    env.PGPASSWORD = SUPER_USER_PASSWORD;
    let psql = proc.spawn(PSQL_CMD, connectParams.concat(commands), { env: env })
    psql.stderr.on('data', (data) => logger.log(printLog(data)));
    return psql;
  }
  sendHUP = (containerName) => proc.spawn('docker',['kill', '-s', 'HUP', containerName]);
  resetDb = () => {
    const {containers} = this.state;
    return this.runSql( ['postgres',
      '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}';`,
      '-c', `DROP DATABASE if exists ${DB_NAME};`,
      '-c', `CREATE DATABASE ${DB_NAME};`
    ])
    .on('close', (code) => {
        this.runSql( [DB_NAME,
            '-f', DB_DIR +'init.sql'
        ]).on('close', (code) => {
          if(code == 0){
            if(containers['postgrest']) {this.sendHUP(containers['postgrest'].name);}
            if(containers['openresty']) {this.sendHUP(containers['openresty'].name);}
          }
        });
    });
  }
  clearLog = (key) => {
    const containerName = containers[key].name;
    const logFile = proc.execSync('docker inspect -f "{{.LogPath}}" ' + containerName ).toString('utf8').trim()
    fs.truncateSync(logFile, 0)
  }
  handleKeyPress = (key) => {
    const {activeContainer, containerOrder, containers, watcherRunning} = this.state;
    switch(key) {
        case 'left':
        case 'right':
          const total = containerOrder.length;
          let idx = containerOrder.indexOf(activeContainer)
          if(key == "left") { idx = (idx - 1 == -1)?(total - 1):(idx - 1); }
          if(key == "right") { idx = (idx + 1 == total)?0:(idx + 1); }
          this.selectContainer(idx);
          break;
        case 'c':// 'Clear log': {keys:['c']},
          //this.clearLog(activeContainer);
          const logger = this.refs['log_'+activeContainer];
          logger.setContent('');
          break;
        case 't':// 'Restart this container': {keys:['t']}, this.restartContainer();
          this.restartContainer(activeContainer);
          break;
        case 'a':// 'Restart all containers'
          Object.keys(containers).map(k => this.restartContainer(k));
          break;
        case 'w':// 'Toggle Watcher'
          watcherRunning ? this.stopWatcher() : this.startWatcher();
          break;
        case 'r':// 'Reset DB'
          this.resetDb();
          break;
        case 'h':// 'Help': {keys:['?']}, this.hideHelp();
          this.setState({showHelp: !this.state.showHelp})
          break;
        // Quit program
        case 'q':
        case 'escape':
        case 'C-c':
          Object.keys(containers).map(c => containers[c].logProc.kill());
          if(this.watcher){ this.watcher.close();}
          process.exit(0);
          break;
        default:
          this.selectContainer(parseInt(key, 10) - 1);
    }
  }

  render() {
    const {containers, containerOrder, activeContainer, showHelp} = this.state;
    const containerTitles = containerOrder.map(key => containers[key].title);
    const topMenuStyle = {
      style: {
        selected:{
          fg: "green"
        },
        item: {
          fg: "grey"
        }
      }
    }
    const logWindowStyle = {
      border: {
        type: 'line',
        fg: 'green'
      },
      width: "100%",
      height: "100%-2",
      keys: true,
      vi: true,
      scrollback: LOG_LENGTH,
      scrollbar: {
        ch: ' ',
        style: {
          inverse: true
        }
      }
    };

    const helpWindowOptions = {
      position: {
        top: "center",
        left: "center",
        width: 64,
        height: 10
      },
      border: "line",

      style: {
        border: {
          fg: "white"
        }
      },
      tags: true,
      content: [
        "{center}{bold}keybindings{/bold}{/center}",
        "",
        "{cyan-fg}    left, right{/}  rotate through logs",
        "{cyan-fg}              h{/}  toggle help",
        "{cyan-fg} esc, ctrl-c, q{/}  quit",
        "",
      ].join("\n")
    }
    return (
      <element keyable={true} ref="dashboard">

        <listbar ref="topMenu"  top={0} items={containerTitles} class={topMenuStyle} />
        {containerOrder.map( key =>
          <log key={key} hidden={key != activeContainer} focused={key == activeContainer}
            ref={'log_' + key} top={1} label="Logs" class={logWindowStyle} />
        )}
        <listbar ref="bottomMenu" bottom={0} height={1} width="100%-2" left={2} autoCommandKeys={false} commands={{
          'Clear log': {keys:['c']},
          'Restart this container': {keys:['t']},
          'Restart all containers': {keys:['a']},
          'Toggle Watcher' : {keys:['w']},
          'Reset DB': {keys:['r']},
          'Help': {keys:['h']},
        }} />
        <box class={helpWindowOptions} hidden={!showHelp}/>

        <Spinner ref="watcherSpinner" bottom={0} left={0} />
      </element>
    );
  }
}

const screen = blessed.screen({
  autoPadding: true,
  smartCSR: true,
  title: 'subZero devtools',
  fullUnicode: true
});

const runDashboard = () => {
  const container_list = proc.execSync('docker ps -a -f name=${COMPOSE_PROJECT_NAME} --format "{{.Names}}"').toString('utf8').trim().split("\n");
  const containers = container_list.reduce( ( acc, containerName ) => {
    let key = containerName.replace(COMPOSE_PROJECT_NAME,'').replace('1','').replace(/_/g,'');
    if (TITLES[key]) {
      acc[key] = {
        name: containerName,
        title: TITLES[key]
      }
    }
    return acc
  }, {});


  render(<Dashboard containers={containers} />, screen);
}


program
  .version(version)
  .parse(process.argv);

runDashboard();
