import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { RoomsService } from './rooms.service';
import { Server, Socket } from 'socket.io';
import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { HttpToSocketExceptionFilter } from 'src/common/exception-filter/http-to-ws.exception';
import { AuthService } from 'src/auth/auth.service';
import { UsersService } from 'src/users/users.service';
import { ProblemsService } from 'src/problems/problems.service';
import {
  ITEM_CREATE_CYCLE as CREATE_ITEM_CYCLE,
  LOBBY_ID,
  NUM_OF_ROUNDS,
  SUCCESS_STATUS,
  TIME_LIMIT,
} from './rooms.constants';
import { RoomsInputDto } from './dtos/rooms.input.dto';
import RoomsInviteDto from './dtos/rooms.invite.dto';
import { plainToClass } from 'class-transformer';
import { RoomsUserDto } from './dtos/rooms.user.dto';

@WebSocketGateway({
  namespace: 'rooms',
  path: '/api/rooms',
  cors: true,
})
@UseFilters(HttpToSocketExceptionFilter)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class RoomsGateway {
  private readonly logger = new Logger(RoomsGateway.name);

  constructor(
    private readonly roomsService: RoomsService,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly problemsService: ProblemsService,
  ) {}

  @WebSocketServer()
  server: Server;

  async handleConnection(socket: Socket) {
    const rawToken = socket.handshake.headers.authorization;

    if (!rawToken) {
      socket.emit('connection', {
        status: 'fail',
        message: 'Token not found',
      });

      socket.disconnect();
      return;
    }

    try {
      const token = this.authService.extractTokenFromHeader(rawToken, true);
      const payload = this.authService.verifyToken(token);
      const user = await this.usersService.getUserByEmail(payload.email);

      if (this.roomsService.isConnectedUser(user.name)) {
        socket.emit('connection', {
          status: 'fail',
          message: 'Already connected user',
        });

        socket.disconnect();
        return;
      }

      socket.data.user = user;
      socket.data.token = token;
      socket.data.type = payload.type;
      this.roomsService.registerSocketId(user.name, socket.id);
    } catch (e) {
      socket.emit('connection', {
        status: 'fail',
        message: 'Token is invalid',
      });

      socket.disconnect();
    }
  }

  async handleDisconnect(socket: Socket) {
    if (!socket.data.user) {
      return;
    }

    this.roomsService.exitRoom(socket.data.roomId, socket.data.user.name);
    this.roomsService.deleteSocketId(socket.data.user.name);
    if (socket.data.roomId) {
      if (socket.data.roomId === LOBBY_ID) {
        this.server.in(socket.data.roomId).emit('user_exit_lobby', {
          userName: socket.data.user.name,
          message: `${socket.data.user.name} ${socket.data.roomId} 방에서 나갔습니다.`,
        });
      } else {
        if (this.roomsService.roomInfo(socket.data.roomId)) {
          this.server.in(socket.data.roomId).emit('user_exit_room', {
            userName: socket.data.user.name,
            message: `${socket.data.user.name} ${socket.data.roomId} 방에서 나갔습니다.`,
          });
        } else {
          this.server
            .in('lobby')
            .emit('delete_room', { roomId: socket.data.roomId });
        }
      }
    }
  }

  @SubscribeMessage('lobby_info')
  lobbyInfo() {
    return this.roomsService.lobbyInfo();
  }

  @SubscribeMessage('room_info')
  roomInfo(@MessageBody() data: RoomsInputDto) {
    return this.roomsService.roomInfo(data.roomId);
  }

  @SubscribeMessage('enter_lobby')
  enterLobby(@ConnectedSocket() client: Socket) {
    const roomsUserDto = plainToClass(RoomsUserDto, {
      socketId: client.id,
      userName: client.data.user.name,
      ready: false,
      passed: false,
      itemList: {},
    });

    this.roomsService.enterRoom(LOBBY_ID, client.data.roomId, roomsUserDto);
    client.join(LOBBY_ID);
    client.data.roomId = LOBBY_ID;
    client.to(LOBBY_ID).emit('user_enter_lobby', {
      userName: roomsUserDto.userName,
    });

    return { status: 'success' };
  }

  @SubscribeMessage('exit_lobby')
  exitLobby(@ConnectedSocket() client: Socket) {
    this.roomsService.exitRoom(LOBBY_ID, client.data.user.name);
    client.leave(LOBBY_ID);
    this.server.in(LOBBY_ID).emit('user_exit_lobby', {
      userName: client.data.user.name,
    });

    return { status: 'success' };
  }

  @SubscribeMessage('create_room')
  createRoom(@ConnectedSocket() client: Socket, @MessageBody() data) {
    const { capacity, roomName } = data;
    const roomId = this.roomsService.createRoom(roomName, capacity);

    this.server.in('lobby').emit('user_create_room', {
      ...this.roomsService.roomInfo(roomId),
      userName: client.data.user.name,
    });

    return {
      status: 'success',
      roomId,
    };
  }

  @SubscribeMessage('enter_room')
  enterRoom(@ConnectedSocket() client: Socket, @MessageBody() data) {
    const { roomId } = data;
    const dto = plainToClass(RoomsUserDto, {
      socketId: client.id,
      userName: client.data.user.name,
      ready: false,
      itemList: {},
    });

    this.roomsService.enterRoom(roomId, client.data.roomId, dto);
    client.join(roomId);
    client.data.roomId = roomId;

    client.to(roomId).emit('user_enter_room', {
      userName: dto.userName,
      message: `${dto.userName} 님이 ${
        this.roomsService.getGameRoom(roomId).roomName
      } 방에 접속했습니다.`,
    });

    this.server.in(LOBBY_ID).emit('change_user_count', {
      roomId,
      userCount: this.roomsService.roomUserCount(roomId),
    });

    return {
      status: 'success',
      roomId,
    };
  }

  @SubscribeMessage('exit_room')
  exitRoom(@ConnectedSocket() client: Socket) {
    const { roomId } = client.data;
    const { name: userName } = client.data.user;
    const roomExists = this.roomsService.exitRoom(roomId, userName);

    client.leave(roomId);
    if (roomExists) {
      this.server.in(roomId).emit('user_exit_room', { userName });
      this.server.in(LOBBY_ID).emit('change_user_count', {
        roomId,
        userCount: this.roomsService.roomUserCount(roomId),
      });
    } else {
      this.server.in(LOBBY_ID).emit('delete_room', { roomId });
    }

    return { status: SUCCESS_STATUS, roomId };
  }

  @SubscribeMessage('chat')
  chat(@ConnectedSocket() client: Socket, @MessageBody() data) {
    const { roomId } = client.data;
    const { message } = data;

    this.server.in(roomId).emit('chat', {
      userName: client.data.user.name,
      message,
    });
  }

  @SubscribeMessage('dm')
  dm(@ConnectedSocket() client: Socket, @MessageBody() data) {
    const { userName, message } = data;
    const targetSocketId = this.roomsService.getSocketId(userName);
    const status = this.roomsService.dm(client.data.user.name);

    this.server.to(targetSocketId).emit('user_dm', {
      userName: client.data.user.name,
      message,
    });

    return { status };
  }

  @SubscribeMessage('ready')
  ready(@ConnectedSocket() client: Socket) {
    const { roomId } = client.data;
    const { name: userName } = client.data.user;
    const ready = this.roomsService.switchReady(roomId, userName);

    this.server.in(roomId).emit('ready', { userName, ready });
    if (this.roomsService.allUserReady(roomId)) {
      this.start(roomId);
    }
  }

  @SubscribeMessage('kick')
  kick(@ConnectedSocket() client: Socket, @MessageBody() data) {
    const { roomId } = client.data;
    const { name: userName } = client.data.user;
    const { userName: targetUserName } = data;
    const status = this.roomsService.kick(roomId, userName, targetUserName);
    const targetSocket = this.socket(
      this.roomsService.getSocketId(targetUserName),
    );

    targetSocket.leave(roomId);
    targetSocket.emit('kick', { roomId, userName });
    this.server.in(roomId).emit('user_exit_room', { userName: targetUserName });
    this.server.in(LOBBY_ID).emit('change_user_count', {
      roomId,
      userCount: this.roomsService.roomUserCount(roomId),
    });

    return { status };
  }

  @SubscribeMessage('item')
  useItem(@ConnectedSocket() client: Socket, @MessageBody() data) {
    const { roomId } = client.data;
    const { name: userName } = client.data.user;
    const { item } = data;
    const status = this.roomsService.useItem(roomId, userName, item);

    client.to(roomId).emit('item', {
      status,
      userName,
      item,
    });
  }

  @SubscribeMessage('pass')
  pass(@ConnectedSocket() client: Socket) {
    const { roomId } = client.data;
    let timer = this.roomsService.getTimer(roomId);

    client.data.passed = true;

    if (this.roomsService.allUserPassed(roomId) && timer) {
      clearTimeout(timer);
      this.roomsService.gameOver(roomId);
      this.server.in(roomId).emit('game_over');
      this.server.in('lobby').emit('room_game_over', { roomId });

      return;
    }

    if (timer) return;

    timer = setTimeout(() => {
      this.roomsService.gameOver(roomId);
      this.server.in(roomId).emit('game_over');
      this.server.in('lobby').emit('room_game_over', { roomId });
    }, TIME_LIMIT);

    this.roomsService.setTimer(roomId, timer);
    this.server.in(roomId).emit('countdown');
  }

  @SubscribeMessage('exit_result')
  exitResult(@ConnectedSocket() client: Socket) {
    const { roomId } = client.data;

    if (this.roomsService.roomHasUser(roomId, client.data.user.id)) {
      client.emit('exit_result');
    }
  }

  @SubscribeMessage('invite')
  invite(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: RoomsInputDto,
  ) {
    const targetUserSocket = this.socket(
      this.roomsService.getSocketId(data.userName),
    );
    const dto = plainToClass(RoomsInviteDto, {
      roomId: client.data.roomId,
      targetUserRoomId: targetUserSocket.data.roomId,
      userName: client.data.user.name,
    });
    const inviteInfo = this.roomsService.invite(
      plainToClass(RoomsInviteDto, dto),
    );

    targetUserSocket.emit('invite', inviteInfo);

    return { status: 'success' };
  }

  private socket(id: string): Socket {
    return this.server.sockets[id];
  }

  private createItem(roomId: string) {
    const socketIdList = this.roomsService.roomSocketIdList(roomId);

    socketIdList.forEach((socketId) => {
      const socket = this.socket(socketId);
      const { name: userName } = socket.data.user;
      const item = this.roomsService.assignItem(roomId, userName);

      socket.emit('create_item', { item });
    });
  }

  private async start(roomId: string) {
    const problems =
      await this.problemsService.findProblemsWithTestcases(NUM_OF_ROUNDS);
    const itemCreator = setInterval(
      () => this.createItem(roomId),
      CREATE_ITEM_CYCLE,
    );

    this.roomsService.changeRoomState(roomId, 'playing');
    this.roomsService.setItemCreator(roomId, itemCreator);
    this.server.in(roomId).emit('start', { problems });
    this.server.in(LOBBY_ID).emit('room_start', { roomId, state: 'playing' });
  }
}
