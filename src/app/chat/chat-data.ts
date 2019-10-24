import {ChatInfo} from './chat-info';
import {ChatManagerComponent} from './chat-manager/chat-manager.component';
import {ChatMessage, ChatMessageType} from './chat-message';

export class ChatData {
  hidden = false;
  messages: ChatMessage[] = [];
  stats = new ChatStats();
  timestamp = Date.now();
  preferences: any = {};

  readonly info: ChatInfo;
  private bufferMaxLines = 300;

  constructor(
    target: string | ChatInfo,
    private chatManager: ChatManagerComponent
  ) {
    if (target instanceof ChatInfo) {
      this.info = target;
    } else {
      this.info = new ChatInfo(target);
    }
  }

  // Public methods
  target(): ChatInfo {
    return this.info;
  }
  manager() {
    return this.chatManager;
  }
  send(message: string) {
    const name = this.target().name;
    // deliver message to this chat
    this.chatManager.client().send(name, message);
    // Add the outgoing message to the buffer as well
    this.receive({
      type: ChatMessageType.MESSAGE,
      sender: this.chatManager.client().config.nick,
      target: name,
      message,
      rendered: {},
      isLocal: true
    });
  }
  receive(message: ChatMessage): ChatMessage {

    message = Object.assign(new ChatMessage(), message);
    if (message.message.startsWith('\x01ACTION ') && message.message.endsWith('\x01')) {
      message.type = ChatMessageType.ACTION;
      message.message = message.message.slice(8, -1);
    }

    // strip color codes (sorry... not supported yet =/)
    // TODO: add suport for IRC color codes
    message.rendered.message = message.message
      .replace(/(\u0002+)|(\u0003+)(\d{1,2})?(,(\d{1,2}))?/g, '');

    // find chatUser nick in sentence and make it bold
    let nickMatched = false;
    const nick = this.chatManager.client().config.nick; // <--- TODO: create an @Injectable IrcClientService
    const replacer = new RegExp(`(^|\\b)${nick}(?=\\W|\\w+|$)`, 'ig');
    message.rendered.message = message.rendered.message.replace(replacer, (match) => {
      nickMatched = true;
      return `<strong><u>${nick}</u></strong>`;
    });
    if (!this.preferences.disableNotifications && nickMatched && this.info !== this.chatManager.chat().info) {
      this.chatManager.notify(message.sender, `[${this.info.name}] ${message.message}`, this.info);
    }

    // keep only 'bufferMaxLines' messages
    if (this.messages.length === this.bufferMaxLines) {
      this.messages.shift();
    }
    // add incoming messages to the message buffer
    this.messages.push(message);
    // if this is not the current chat, then increase
    // the number of unread messages
    if (!this.preferences.disableNotifications && message.type === ChatMessageType.MESSAGE && (
        this.chatManager.chat().info.name === 'localhost' ||
        this.target().name !== this.chatManager.chat().info.name ||
        (this.target().name === this.chatManager.chat().info.name && !this.chatManager.isLastMessageVisible())
      )
    ) {
      this.stats.messages.new++;
    }
    this.timestamp = Date.now();

    // TODO: implment this via EventEmitter
    // scroll down to last visible message
    if (this.info === this.manager().chat().info) {
      this.manager().scrollToLast();
    }

    return message;
  }
}

export class ChatStats {
  users: {};
  messages = {
    new: 0
  };
}
