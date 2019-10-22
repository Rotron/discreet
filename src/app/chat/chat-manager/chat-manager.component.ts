import {
  Component,
  ComponentFactoryResolver,
  ElementRef,
  EventEmitter,
  HostListener,
  Injectable,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';

import {MatSnackBar, MatSnackBarRef, SimpleSnackBar} from '@angular/material/snack-bar';

import {IrcClientService} from '../../irc-client-service/irc-client-service';
import {MessagesWindowComponent} from '../messages-window/messages-window.component';
import {ChatInfo} from '../chat-info';
import {ChatData} from '../chat-data';
import {MatDialog, MatMenu} from '@angular/material';
import {ChatUser} from '../chat-user';
import {YoutubeVideoComponent} from '../../socialmedia/youtube-video/youtube-video.component';
import {EmojiDialogComponent} from '../dialogs/emoji-dialog/emoji-dialog.component';
import {DeviceDetectorService} from 'ngx-device-detector';
import {MediaPlaylistComponent} from '../dialogs/media-playlist/media-playlist.component';
import {ChatMessage, ChatMessageType} from '../chat-message';
import {CdkVirtualScrollViewport} from '@angular/cdk/scrolling';
import {ActivatedRoute, Router} from '@angular/router';
import {PublicChat} from '../public-chat';
import {PrivateChat} from '../private-chat';
import {ChannelsListComponent} from '../dialogs/channels-list/channels-list.component';
import {IrcUser} from '../../irc-client-service/irc-user';

@Injectable({
  providedIn: 'root',
})
@Component({
  selector: 'app-chat-manager',
  templateUrl: './chat-manager.component.html',
  styleUrls: ['./chat-manager.component.scss']
})
export class ChatManagerComponent implements OnInit {
  @ViewChild(MessagesWindowComponent, {static: true})
  private messageWindow: MessagesWindowComponent;
  @ViewChild('userMenu', {static: true})
  userMenu: MatMenu;
  @ViewChild(YoutubeVideoComponent, {static: true})
  videoPlayer: YoutubeVideoComponent;
  @ViewChild('messageInput', {static: true})
  messageInput: ElementRef;
  @ViewChild('userListScrollView', {static: false})
  userListScrollView: CdkVirtualScrollViewport;

  private chatList = {
    public: [] as PublicChat[],
    private: [] as PrivateChat[],
    isPublic(target: string | ChatInfo | PublicChat | PrivateChat): boolean {
      return (target instanceof PublicChat)
        || (target instanceof ChatInfo && target.type === 'public')
        || (typeof target === 'string' && target.startsWith('#'));
    },
    find(target: string | ChatInfo): PublicChat | PrivateChat {
      if (this.isPublic(target)) {
        return this.public.find((c) => c.target() === target || c.target().name === target || c.target().prefix === target);
      } else {
        return this.private.find((c) => c.target() === target || c.target().name === target || c.target().prefix === target);
      }
    },
    add(target: string | ChatInfo, chatManager: ChatManagerComponent): PublicChat | PrivateChat {
      let chat = null;
      if (this.isPublic(target)) {
        chat = new PublicChat(target, chatManager);
        this.public.push(chat);
      } else {
        chat = new PrivateChat(target, chatManager);
        this.private.push(chat);
      }
      return chat;
    }
  };
  boundChatList = new BoundChatList();

  currentChat: PrivateChat | PublicChat;
  currentUser: ChatUser;
  currentMenuChat: PrivateChat | PublicChat | any;

  userMessage = '';
  awayMessage = '';
  textInputCaretPosition = 0;
  currentEmojiTextInput;

  userSearchValue = '';

  // state variables
  showRightPanel = true;
  showUserList = true;
  isLoggedIn = false;

  screenHeight = window.innerHeight;
  screenWidth = window.innerWidth;

  @Output() chatClosed = new EventEmitter<any>();
  @Output() chatOpen = new EventEmitter<any>();
  @Output() chatLoading = new EventEmitter<boolean>();

  @HostListener('window:resize', ['$event'])
  onResize(event?) {
    if (this.screenWidth !== window.innerWidth) {
      if (this.screenWidth < 640) {
        this.closeRightPanel();
      } else {
        this.openRightPanel();
      }
    }
    this.screenHeight = window.innerHeight;
    this.screenWidth = window.innerWidth;
  }

  constructor(
    private snackBar: MatSnackBar,
    private componentFactoryResolver: ComponentFactoryResolver,
    public ircClient: IrcClientService,
    public dialog: MatDialog,
    public deviceService: DeviceDetectorService,
    private router: Router,
    private route: ActivatedRoute
  ) {
    // listen to IRC events
    this.ircClient.connectionStatus.subscribe((connected) => {
      // TODO:
    });
    this.ircClient.loggedIn.subscribe((loggedIn) => {
      this.isLoggedIn = loggedIn;
      if (loggedIn) {
        this.chatLoading.emit(false);
      }
    });
    this.ircClient.messageReceive.subscribe((msg: ChatMessage) => {
      const ni = msg.sender.indexOf('!'); // <-- TODO: not sure if this check is still needed
      if (ni > 0) {
        msg.sender = msg.sender.substring(0, ni);
      }
      // the message is for the local user
      if (this.ircClient.config.nick === msg.target) {
        msg.target = msg.sender;
      }
      // set type to MESSAGE (TODO: add support for NOTICE and MOTD TEXT '372')
      msg.type = ChatMessageType.MESSAGE;
      const chat = this.chat(msg.target);
      chat.receive(msg);
      // Show notification popup if message is not coming from the currently opened chat
      if (!chat.preferences.disableNotifications && chat !== this.currentChat && !(chat instanceof PublicChat)) {
        this.notify(msg.sender, msg.message, msg.sender);
      }
    });
    this.ircClient.userJoin.subscribe(({channel, user, msg}) => {
      this.addChatUser(channel, user);
      this.addServiceEvent(
        channel, user.name,
        ChatMessageType.JOIN,
        'è entrato.',
        {description: msg.message}
      );
    });
    this.ircClient.userKick.subscribe(({channel, user, msg}) => {
      this.delChatUser(channel, user);
      this.addServiceEvent(
        channel, user.name,
        ChatMessageType.KICK,
        'è stato espulso.',
        {description: msg.message}
      );
    });
    this.ircClient.userPart.subscribe(({channel, user, msg}) => {
      this.delChatUser(channel, user);
      this.addServiceEvent(
        channel, user.name,
        ChatMessageType.PART,
        'è uscito.',
        {description: msg.message}
      );
    });
    this.ircClient.userQuit.subscribe(({user, msg}) => {
      this.delChatUser(null, user);
      this.addServiceEvent(
        null, user.name,
        ChatMessageType.QUIT,
        'si è disconnesso.',
        {description: msg.message}
      );
    });
    this.ircClient.userNick.subscribe(({oldNick, u, msg}) => {
      this.renChatUser((u as IrcUser).name);
    });
    this.ircClient.joinChannel.subscribe(this.show.bind(this));
    this.ircClient.userMode.subscribe((m) => {
      // TODO: ......................
      console.log('SERVER MODE', m.user, m.mode);
    });
    this.ircClient.chanMode.subscribe((m) => {
      // TODO: ...
      console.log('CHAN MODE', m.user, m.mode);
    });
    this.ircClient.userChannelMode.subscribe((m) => {
      const chat = this.chatList.public.find((c) => c.target().name === m.channel || c.target().prefix === m.channel);
      const user = chat && chat.getUser(m.user.name);
      if (user) {
        user.icon = this.getIcon(user.flags);
        user.color = this.getColor(user.flags);
      }
    });
    this.ircClient.awayReply.subscribe((msg) => {
      msg.type = ChatMessageType.MESSAGE;
      this.chat(msg.sender).receive(msg);
      const channel = this.channel();
      if (channel) {
        const user = channel.getUser(msg.sender);
        if (user) {
          user.away = msg.message;
        }
      }
    });
    this.ircClient.versionReply.subscribe((msg) => {
      //const existingUser = usersList.find((eu) => eu.name === user.name);
      // TODO: implement global users list
      console.log('#####', 'VERSION', msg.sender, msg.version);
    });
  }

  private addServiceEvent(channel: string, sender: string, eventType: ChatMessageType, eventDescription: string, data: any) {
    const chat = this.channel(channel);
    if (chat) {
      const eventMessage = new ChatMessage();
      eventMessage.type = eventType;
      eventMessage.message = eventDescription;
      eventMessage.data = data;
      //eventMessage.data = { description: msg.message };
      eventMessage.sender = sender;
      eventMessage.target = channel;
      chat.receive(eventMessage);
    }
  }

  ngOnInit() {
    this.messageWindow.mediaUrlClick.subscribe((mediaUrl) => {
      if (mediaUrl.id) {
        // YouTube link is opened with built-in player
        this.videoPlayer.loadVideo(mediaUrl.id);
      } else {
        // Other links are opened in a new window
        window.open(mediaUrl.link, '_blank');
      }
    });
    // work-around for ngCheckExpressioneChanged...
    setTimeout(this.connect.bind(this), 100);
  }

  onChatMenuButtonClick(c: PrivateChat | PublicChat) {
    this.currentMenuChat = c;
  }
  onChatButtonClick(c: ChatData) {
    const chat = this.show(c.target());
    // close right panel on smaller screen when a chat is opened
    if (this.screenWidth < 640) {
      this.closeRightPanel();
    }
  }
  onCloseChatClick(c: PrivateChat | PublicChat) {
    this.closeChat(c);
  }

  onUserClick(menu: MatMenu, user: ChatUser) {
    this.currentUser = user;
  }

  onUserMenuChat() {
    this.showUserList = false;
    this.show(this.currentUser.name);
  }
  onToggleNotificationClick(chat: PrivateChat | PublicChat) {
    chat.preferences.disableNotifications = !chat.preferences.disableNotifications;
    // reset message count when toggling notifications
    chat.stats.messages.new = 0;
  }
  onLeaveChannelClick(chat: PrivateChat | PublicChat) {
    // TODO: should ask for confirmation
    this.ircClient.raw(`:1 PART ${chat.info.name}`);
    this.closeChat(chat);
  }
  onUserPlaylistClick(user: ChatUser) {
    if (this.screenWidth < 640) {
      this.closeRightPanel();
    }
    this.router.navigate(['.'], { fragment: 'playlist', relativeTo: this.route });
    const dialogRef = this.dialog.open(MediaPlaylistComponent, {
      panelClass: 'playlist-dialog-container',
      width: '330px',
      data: [ user ],
      closeOnNavigation: true
    });
    dialogRef.afterClosed().subscribe(media => {
      if (media) {
        let videoId = '';
        if (media.url.indexOf('v=') === -1) {
          videoId = media.url.substring(media.url.lastIndexOf('/') + 1);
        } else {
          videoId = media.url.split('v=')[1];
          const ampersandPosition = videoId.indexOf('&');
          if (ampersandPosition !== -1) {
            videoId = videoId.substring(0, ampersandPosition);
          }
        }
        this.videoPlayer.loadVideo(videoId);
      }
    });
  }
  onUserInfoClick(user: ChatUser) {
    this.ircClient.whois(user.name);
    this.ircClient.ctcp(user.name, 'VERSION');
  }

  onEnterKey(e) {
    e.preventDefault();
    // TODO: make a method 'sendMessage' out of this
    // strip unwanted characters codes from string
    let message = this.userMessage.replace(/[\x00-\x1F\x7F]/gu, '');
    if (message.trim() !== '') {
      let spaceIndex = message.indexOf(' ');
      if (message[0] === '/' && spaceIndex > 0) {
        const command = message.substring(1, spaceIndex).toUpperCase();
        let target = message = message.substring(spaceIndex + 1);
        if (command === 'ME') {
          this.userAction(message);
        } else {
          spaceIndex = message.indexOf(' ');
          if (spaceIndex > 0) {
            target = message.substring(0, spaceIndex);
            message = message.substring(spaceIndex + 1);
          }
          switch (command) {
            case 'NICK':
              this.ircClient.nick(target);
              break;
            case 'WHOIS':
              this.ircClient.whois(target);
              break;
            case 'CTCP':
              this.ircClient.ctcp(target, message);
              break;
            case 'JOIN':
              this.ircClient.join(target);
              break;
            case 'PART':
              this.ircClient.part(target);
              break;
            case 'LIST':
              this.ircClient.list();
              break;
            case 'QUERY':
            case 'MSG':
              this.chat(target).send(message);
              break;
          }
        }
      } else {
        this.chat().send(message);
      }
    }
    this.userMessage = '';
    this.scrollToLast(true);
  }

  onOpenEmojiClick(e) {
    const eventEmitter = new EventEmitter<string>();
    this.router.navigate(['.'], { fragment: 'emoji', relativeTo: this.route });
    const dialogRef = this.dialog.open(EmojiDialogComponent, {
      panelClass: 'emoji-dialog-container',
      closeOnNavigation: true,
      data: eventEmitter
    });
    eventEmitter.subscribe((emoji) => {
      const leftPart = this.userMessage.substring(0, this.textInputCaretPosition);
      const rightPart = this.userMessage.substring(this.textInputCaretPosition);
      this.userMessage = leftPart + emoji.native + rightPart;
      this.textInputCaretPosition += emoji.native.length;
    });
    dialogRef.afterClosed().subscribe(emoji => {
      eventEmitter.unsubscribe();
      this.currentEmojiTextInput.focus();
    });
    e.preventDefault();
  }

  onTextInputBlur(e) {
    const textInput = this.currentEmojiTextInput = e.target;
    if (textInput.selectionStart || textInput.selectionStart == '0') {
      this.textInputCaretPosition = textInput.selectionStart;
    }
  }
  onTextInputFocus(e) {
    const textInput = e.target;
    setTimeout(() => {
      textInput.selectionStart = textInput.selectionEnd = this.textInputCaretPosition;
    }, 50);
  }

  onUserSearchChange() {
    const user = this.userSearchValue.toLowerCase();
    const firstMatch = this.channel().users.find((u) => {
      return u.name.toLowerCase().startsWith(user);
    });
    if (firstMatch) {
      const firstMatchIndex = this.channel().users.indexOf(firstMatch);
      this.userListScrollView.scrollToIndex(firstMatchIndex);
    }
  }

  onChannelJoinClick() {
    this.router.navigate(['.'], { fragment: 'channels', relativeTo: this.route });
    const dialogRef = this.dialog.open(ChannelsListComponent, {
      width: '330px',
      closeOnNavigation: true
    });
    dialogRef.afterClosed().subscribe(res => {
      if (res && res.length > 0) {
        this.ircClient.join(res);
        this.show(res);
      }
    });
  }

  closeChat(c: PrivateChat | PublicChat) {
    if (this.currentChat === c) {
      this.currentChat = null;
    }
    // TODO: maybe a setTimeout is required for this to work properly
    c.hidden = true;
  }

  showChatList() {
    if (!this.showUserList && this.isRightPanelOpen()) {
      this.closeRightPanel();
    } else {
      this.showUserList = false;
      this.openRightPanel();
    }
  }
  // TODO: 'PrivateChat' should not be a valid argument type here
  //       it's left as a work-around for 'not assignable' error
  //       when used in template.
  showChatUsers(chat?: PublicChat | PrivateChat) {
    if (this.showUserList && this.isRightPanelOpen()) {
      this.closeRightPanel();
    } else {
      this.show(chat ? chat.info : this.channel().info);
      this.showUserList = true;
      this.openRightPanel();
    }
  }

  // hide/show join/part/kick/quit messages
  toggleChannelActivity() {
    const chat = this.channel();
    if (chat) {
      chat.preferences.showChannelActivity = !chat.preferences.showChannelActivity;
    }
  }

  notify(from, message, target) {
    const snackBarRef: MatSnackBarRef<SimpleSnackBar> = this.snackBar.open(`${from}: ${message}`, 'Mostra', {
      duration: 5000,
      verticalPosition: 'top'
    });
    snackBarRef.onAction().subscribe(() => {
      this.show(target);
    });
    const audio = new Audio('https://raw.githubusercontent.com/genielabs/chat/master/docs/assets/audio/notifications.mp3');
    audio.play();
  }

  scrollToLast(force?: boolean) {
    this.messageWindow.scrollLast(force);
  }

  userAction(message: string) {
    // TODO: this.ircClient.action(target, message)
    message = `\x01ACTION ${message}\x01`;
    this.chat().send(message);
  }
  setAway(reason?: string) {
    this.awayMessage = reason;
    this.ircClient.away(reason);
  }

  newMessageCount() {
    let newMessages = 0;
    // new messages from public channels
    this.chatList.public.forEach((c) => {
      if (c !== this.currentChat && !c.hidden) {
        newMessages += c.stats.messages.new;
      }
    });
    // new messages from users
    this.chatList.private.forEach((c) => {
      if (c !== this.currentChat && !c.hidden) {
        newMessages += c.stats.messages.new;
      }
    });
    return newMessages > 99 ? '99+' : newMessages;
  }

  isRightPanelOpen() {
    return this.showRightPanel;
  }
  openRightPanel() {
    this.showRightPanel = true;
    this.videoPlayer.setRightMargin(true);
  }
  closeRightPanel() {
    this.showRightPanel = false;
    this.videoPlayer.setRightMargin(false);
  }

  connect() {
    this.isLoggedIn = false;
    this.chatLoading.emit(true);
    this.chatList.public.forEach((c) => {
      c.users = [] as ChatUser[];
    });
    this.ircClient.connect().subscribe(null, (error) => {
      this.chatLoading.emit(false);
      this.isLoggedIn = false;
      this.snackBar.open('Connessione interrotta.', 'Connetti', {
        verticalPosition: 'bottom'
      }).onAction().subscribe(() => {
        this.connect();
      });
    }, () => {
      this.chatLoading.emit(false);
      this.isLoggedIn = false;
      this.snackBar.open('Connessione interrotta.', 'Connetti', {
        verticalPosition: 'bottom'
      }).onAction().subscribe(() => {
        this.connect();
      });
    });
  }

  disconnect() {
    this.ircClient.disconnect();
  }

  client() {
    return this.ircClient;
  }

  show(target: string | ChatInfo) {
    this.chatLoading.emit(true);
    const chat = this.currentChat = this.chat(target);
    setTimeout(() => {
      chat.stats.messages.new = 0;
      this.messageWindow.bind(chat);
      if (!chat.info.name.startsWith('#')) {
        this.showUserList = false;
      }
      if (!this.deviceService.isMobile()) {
        // TODO: focus input text
        (this.messageInput.nativeElement as HTMLElement).focus();
      }
      this.chatLoading.emit(false);
    });
    return chat;
  }

  channel(target?: string | ChatInfo): PublicChat {
    if (target == null && this.isPublicChat(this.currentChat)) {
      return (this.currentChat as PublicChat);
    }
    return this.chatList.public.find((c) => {
      return (target == null || c.target() === target || c.target().name === target || c.target().prefix === target);
    });
  }
  chat(target?: string | ChatInfo): PublicChat | PrivateChat {
    if (target == null && this.currentChat) {
      // if no argument is provided return the currently open chat
      return this.currentChat;
    } else if (target == null) {
      // default loopback chat
      return new PrivateChat('MediaChat', this);
    }
    let chat = this.chatList.find(target);
    if (chat == null) {
      chat = this.chatList.add(target, this);
      if (target) {
        // force *ngFor refresh by re-assigning chatList
        this.boundChatList = new BoundChatList();
        this.boundChatList.public = this.chatList.public;
        this.boundChatList.private = this.chatList.private;
        // automatically open chat if it's a channel
        if (chat instanceof PublicChat) { // TODO: add facility 'chat.isChannel()'
          this.showUserList = true;
          this.chatOpen.emit(chat);
          this.show(target);
        } else if (this.screenWidth <= 640) {
          this.closeRightPanel();
        }
      }
    }
    if (chat !== this.currentChat) {
      chat.hidden = false;
    }
    return chat;
  }

  isPublicChat(target?: string | ChatInfo | PublicChat | PrivateChat) {
    return target && this.chatList.isPublic(target);
  }
  isPrivateChat(target?: string | ChatInfo | PublicChat | PrivateChat) {
    return target && !this.chatList.isPublic(target);
  }

  filterChat(chat: ChatData) {
    return !chat.hidden;
  }

  getColor(c: ChatData | string): string {
    if (c == null) {
      return 'error';
    }
    let prefix = '';
    if (typeof c === 'string') {
      prefix = c;
    } else {
      if (c instanceof PublicChat) {
        return 'primary';
      }
      prefix = c.info.name;
    }
    if (this.isAdministrator(prefix) || this.isOwner(prefix)) {
      return 'accent';
    }
    if (this.isOperator(prefix)) {
      return 'primary';
    }
    if (this.isHalfOperator(prefix)) {
      return 'warn';
    }
    return '';
  }

  getIcon(c: ChatData | string): string {
    if (c == null) {
      return 'error';
    }
    let prefix = '';
    if (typeof c === 'string') {
      prefix = c;
    } else {
      if (c instanceof PublicChat) {
        return 'people_alt';
      }
      prefix = c.info.name;
    }
    if (this.isOwner(prefix)) {
      return 'stars';
    }
    if (this.isAdministrator(prefix)) {
      return 'security';
    }
    if (this.isOperator(prefix)) {
      return 'security';
    }
    if (this.isHalfOperator(prefix)) {
      return 'how_to_reg';
    }
    if (this.isVoice(prefix)) {
      return 'record_voice_over';
    }
    return 'person';
  }

  // TODO: move the following methods th IrcUtil

  /*

  IRC User Roles
  --------------
  ~ for owners – to get this, you need to be +q in the channel
  & for admins – to get this, you need to be +a in the channel
  @ for full operators – to get this, you need to be +o in the channel
  % for half operators – to get this, you need to be +h in the channel
  + for voiced users – to get this, you need to be +v in the channel

  */
  isOwner(name) {
    return name.indexOf('~') >= 0;
  }

  isAdministrator(name) {
    return name.indexOf('&') >= 0;
  }

  isHalfOperator(name) {
    return name.indexOf('%') >= 0;
  }

  isOperator(name) {
    return name.indexOf('@') >= 0;
  }

  isVoice(name) {
    return name.indexOf('+') >= 0;
  }

  removeUserNameFlags(name: string): string {
    return name.replace(/[~&@%+]/g,'');
  }

  getUsersList(target: string) {
    const chat = this.chatList.find(target);
    return chat && (chat as PublicChat).users;
  }

  private addChatUser(target: string, u: IrcUser) {
    // TODO: should check chatList.isPublic(target) and throw an exception if not
    const usersList = this.getUsersList(target);
    const user = new ChatUser(target, u);
    user.color = this.getColor(u.prefix);
    user.icon = this.getIcon(u.prefix);
    // TODO: this duplicate check could be removed
    // const existingUser = usersList.find((eu) => eu.name === user.name);
    // if (existingUser == null) {
    //   usersList.push(user);
    // }
    usersList.push(user);
    this.sortUsersList(target);
    // TODO: if this is not for forcing user list (virtual-scroll) refresh, remove it
    const chat = this.chatList.find(target);
    (chat as PublicChat).users = [...usersList];
  }
  private renChatUser(user: string) {
    this.chatList.public.forEach((c) => {
      if (c.getUser(user)) {
        this.sortUsersList(c.info.name);
      }
    });
  }
  private delChatUser(target: string, user: IrcUser) {
    if (target == null) {
      this.chatList.public.forEach((c) => {
        const userList = c.users;
        const u = userList.find((n) => n.user === user);
        const ui = userList.indexOf(u);
        if (ui !== -1) {
          userList.splice(ui, 1);
        }
      });
    } else {
      const userList = this.getUsersList(target);
      const u = userList.find((n) => n.user === user);
      const ui = userList.indexOf(u);
      if (ui !== -1) {
        userList.splice(ui, 1);
      }
    }
  }
  private sortUsersList(target: string) {
    this.getUsersList(target).sort((a, b) => {
      if (this.getUsersSortValue(a) < this.getUsersSortValue(b)) {
        return -1;
      }
      if (this.getUsersSortValue(a) > this.getUsersSortValue(b)) {
        return 1;
      }
      return 0;
    });
  }
  private getUsersSortValue(u: ChatUser) {
    let user = u.flags + u.name.toLowerCase();
    if (this.isOwner(user)) {
      user = user.replace('~', '0:');
    } else if (this.isAdministrator(user)) {
      user = user.replace('&', '1:');
    } else if (this.isOperator(user)) {
      user = user.replace('@', '2:');
    } else if (this.isHalfOperator(user)) {
      user = user.replace('%', '3:');
    } else if (this.isVoice(user)) {
      user = user.replace('+', '4:');
//    } else if (u.hasPlaylist()) {
//      user = '5:' + user;
    } else {
      user = '6:' + user;
    }
    user = this.removeUserNameFlags(user);
    return user;
  }

  isLastMessageVisible() {
    return this.messageWindow.isLastMessageVisible;
  }
}

export class BoundChatList {
  public: PublicChat[] = [];
  private: PrivateChat[] = [];
  hasActivePublicChats(): boolean {
    return this.public.reduce((a, b) => a + (!b.hidden ? 1 : 0), 0) > 0;
  }
  hasActivePrivateChats(): boolean {
    return this.private.reduce((a, b) => a + (!b.hidden ? 1 : 0), 0) > 0;
  }
}
