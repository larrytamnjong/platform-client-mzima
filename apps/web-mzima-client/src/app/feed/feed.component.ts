import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { FormControl } from '@angular/forms';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Params, Router, NavigationEnd } from '@angular/router';
import { Permissions } from '@enums';
import { searchFormHelper } from '@helpers';
import { TranslateService } from '@ngx-translate/core';
import { UntilDestroy, untilDestroyed } from '@ngneat/until-destroy';
import { NgxMasonryComponent, NgxMasonryOptions } from 'ngx-masonry';
import { filter, forkJoin, Subject, debounceTime } from 'rxjs';
import { PostDetailsModalComponent } from '../map';
import { MainViewComponent } from '@shared';
import { SessionService, BreakpointService, EventBusService, EventType } from '@services';
import { ConfirmModalService } from '../core/services/confirm-modal.service';
import { LanguageService } from '../core/services/language.service';
import {
  SavedsearchesService,
  PostsService,
  GeoJsonFilter,
  PostResult,
  PostStatus,
  postHelpers,
} from '@mzima-client/sdk';
import _, { capitalize } from 'lodash';

enum FeedMode {
  Tiles = 'TILES',
  Post = 'POST',
}

@UntilDestroy()
@Component({
  selector: 'app-feed',
  templateUrl: './feed.component.html',
  styleUrls: ['./feed.component.scss'],
})
export class FeedComponent extends MainViewComponent implements OnInit {
  @ViewChild('feed') public feed: ElementRef;
  @ViewChild('masonry') public masonry: NgxMasonryComponent;
  private readonly getPostsSubject = new Subject<{
    params: GeoJsonFilter;
    add?: boolean;
  }>();
  public pagination = {
    page: 0,
    limit: 20,
  };
  public eventToTriggerModal: string = 'none'; // will help the app keep track of if click has happened later on
  public postsSkeleton = new Array(20).fill(''); // used for Post mode's skeleton loader
  public posts: PostResult[] = [];
  public postCurrentLength = 0;
  public isLoading: boolean = true;
  public atLeastOnePostExists: boolean;
  public noPostsYet: boolean = false;
  public loadingMorePosts: boolean;
  public paginationElementsAllowed: boolean = false;
  public mode: FeedMode = FeedMode.Tiles;
  public activePostId: number;
  public total: number;
  public postDetails?: PostResult;
  public isPostLoading: boolean;
  public isFiltersVisible: boolean;
  public isBulkOptionsVisible: boolean;
  public selectedPosts: PostResult[] = [];
  public statuses = searchFormHelper.statuses;
  public sortingOptions = searchFormHelper.sortingOptions;
  public activeSorting = {
    order: 'desc',
    orderby: 'created',
  };
  public updateMasonryLayout: boolean;
  private isRTL?: boolean;
  public masonryOptions: NgxMasonryOptions = {
    originLeft: false,
    percentPosition: false, // setting this to false makes mode-related UI transition cleaner, whether on post card/mode switch button or on Data view sidebar Nav button click
    resize: true,
    gutter: 0,
    columnWidth: 3,
    fitWidth: false,
    horizontalOrder: true,
  };
  FeedMode = FeedMode;
  public currentPage = 1;
  public itemsPerPage = 20;
  private postDetailsModal: MatDialogRef<PostDetailsModalComponent>;
  public isMainFiltersOpen: boolean;
  public isManagePosts: boolean;
  public statusControl = new FormControl();
  public initialLoad = true;

  constructor(
    protected override router: Router,
    protected override route: ActivatedRoute,
    protected override postsService: PostsService,
    protected override savedSearchesService: SavedsearchesService,
    protected override eventBusService: EventBusService,
    protected override sessionService: SessionService,
    protected override breakpointService: BreakpointService,
    private confirmModalService: ConfirmModalService,
    private dialog: MatDialog,
    private translate: TranslateService,
    private languageService: LanguageService,
    private snackBar: MatSnackBar,
  ) {
    super(
      router,
      route,
      postsService,
      savedSearchesService,
      eventBusService,
      sessionService,
      breakpointService,
    );

    this.checkDesktop();
    this.setupFeedDefaultFilters();
    this.initGetPostsListener();

    // e.g. for when sidebar nav btn/link is used to navigate to feed view
    // this.router.navigate([], {
    //   relativeTo: this.route,
    //   queryParamsHandling: 'merge',
    // });

    this.route.params.subscribe(() => {
      this.initCollection();
    });

    this.route.queryParams.subscribe({
      next: (params: Params) => {
        this.currentPage = params['page'] ? Number(params['page']) : 1;
        this.params.page = this.currentPage;
        this.mode = params['mode'] === FeedMode.Post ? FeedMode.Post : FeedMode.Tiles;
        this.updateMasonry();
        // NOTE on params[mode] and TILES mode (just to avoid confusion):
        // console.log('mode: ', params['mode']); // will always return undefined when in TILES mode, if browser url (query params) does not include "mode=TILES" e.g. when browser url is at "/feed"
        if (!this.posts) this.getPostsSubject.next({ params: this.params });
      },
    });

    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe((/*event*/) => {
        this.activePostId = Number(this.router.url.match(/\/(\d+)\/[^\/]+$/)?.[1]);
        const postModeHint = this.activePostId;
        this.mode = postModeHint ? FeedMode.Post : FeedMode.Tiles;
        if (this.mode === FeedMode.Post) {
          // Note: Without this event check, clicking on card will also trigger the modal for load - we want to block that from happening
          if (this.eventToTriggerModal === 'none')
            this.modal({ event: 'load' }).popup.onLoad({ id: postModeHint });
        }
      });

    this.postsService.postsFilters$.pipe(untilDestroyed(this)).subscribe({
      next: () => {
        this.isLoading = true; // "There are no posts yet!" flicker is fixed here and for (most) places where isLoading is set to true
        if (this.initialLoad) {
          this.initialLoad = false;
          return;
        }
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: {
            page: 1,
          },
          queryParamsHandling: 'merge',
        });
        this.posts = [];
        this.getPostsSubject.next({ params: this.params });
      },
    });

    this.postsService.totalPosts$.pipe(untilDestroyed(this)).subscribe({
      next: (total) => {
        this.total = total;
      },
    });

    this.sessionService.isFiltersVisible$.pipe(untilDestroyed(this)).subscribe({
      next: (isFiltersVisible) => {
        setTimeout(() => {
          this.isFiltersVisible = isFiltersVisible;
        }, 1);
      },
    });

    this.languageService.isRTL$.pipe(untilDestroyed(this)).subscribe({
      next: (isRTL) => {
        if (this.isRTL !== isRTL) {
          this.isRTL = isRTL;
          this.masonryOptions.originLeft = !this.isRTL;
        }
      },
    });

    window.addEventListener('resize', () => {
      this.modal({ event: 'resize' }).popup.onResize({});
    });

    // window.addEventListener('resize', () => {
    //   this.masonryOptions.columnWidth =
    //     this.mode === FeedMode.Tiles
    //       ? window.innerWidth > 1640
    //         ? 3
    //         : window.innerWidth <= 768
    //         ? 1
    //         : 2
    //       : 1;
    // });

    this.sessionService.isMainFiltersHidden$.pipe(untilDestroyed(this)).subscribe({
      next: (isMainFiltersHidden: boolean) => {
        setTimeout(() => {
          this.isMainFiltersOpen = !isMainFiltersHidden;
        }, 1);
      },
    });
  }

  ngOnInit() {
    this.getUserData();
    this.checkPermission();
    this.eventBusListeners();
  }

  private setupFeedDefaultFilters() {
    if (this.params.include_unstructured_posts) this.params['form[]']?.push('0');
    this.params.currentView = 'feed';
    (this.params.limit = 20),
      (this.params.page = 1),
      (this.pagination = {
        limit: this.params.limit,
        page: this.params.page,
      });
  }

  private eventBusListeners() {
    this.eventBusService
      .on(EventType.DeleteCollection)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: (colId) => {
          if (Number(colId) === Number(this.collectionId)) {
            this.router.navigate(['/feed']);
          }
        },
      });

    this.eventBusService
      .on(EventType.DeleteSavedSearch)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          // We can delete search only from edit so redirect anyway
          this.router.navigate(['/feed']);
        },
      });

    this.eventBusService
      .on(EventType.UpdatedPost)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: (post) => {
          this.refreshPost(post);
        },
      });

    this.eventBusService
      .on(EventType.EditPost)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: (post) => {
          this.editPost(post);
        },
      });

    this.eventBusService
      .on(EventType.DeletedPost)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: (post) => {
          this.postDeleted([post], 0);
        },
      });
  }

  private checkPermission() {
    this.isManagePosts = this.user.permissions?.includes(Permissions.ManagePosts) ?? false;
  }

  loadData(): void {
    // this.params.page = 1;
    this.getPostsSubject.next({ params: this.params });
  }

  private initGetPostsListener() {
    this.getPostsSubject.pipe(untilDestroyed(this), debounceTime(700)).subscribe({
      next: ({ params, add }) => {
        this.getPosts(params, add);
      },
    });
  }

  private getPosts(params: any, add = true): void {
    const isPostsAlreadyExist = !!this.posts.length;
    if (!add) {
      this.posts = [];
    }
    // if (this.mode === FeedMode.Post) {
    //   this.currentPage = 1;
    // }

    //---------------------------------
    this.isLoading = !this.posts.length; // With this skeleton loader shows up only on mode switch, and the loadmore button is able to detect to not load the skeleton UI loader on click
    this.paginationElementsAllowed = this.loadingMorePosts; // this check prevents the load more button & area from temporarily disappearing (on click) [also prevents pagination element flicker in TILES mode]
    //----------------------------------
    this.postsService.getPosts('', { ...params, ...this.activeSorting }).subscribe({
      next: (data) => {
        this.posts = add ? [...this.posts, ...data.results] : data.results;
        const dataMetaPerPage = Number(data.meta.per_page);
        this.postCurrentLength =
          data.count < dataMetaPerPage ? data.meta.total : data.meta.current_page * data.count;
        this.eventBusService.next({
          type: EventType.FeedPostsLoaded,
          payload: true,
        });
        setTimeout(() => {
          //---------------------------------
          // These are needed to achieve clean display of posts or message on the UI
          this.isLoading = false;
          this.atLeastOnePostExists = this.posts.length > 0;
          this.noPostsYet = !this.atLeastOnePostExists; // && this.mode === FeedMode.Tiles;
          this.loadingMorePosts = false; // for load more button's loader/spinner
          //---------------------------------
          this.updateMasonry();
          setTimeout(() => {
            if (this.mode === FeedMode.Post && !isPostsAlreadyExist) {
              document.querySelector('.post--selected')?.scrollIntoView();
            }
          }, 250);
        }, 500);
        setTimeout(() => {
          //is inside this much delayed setTimeout to prevent pagination elements flicker on load/routing
          this.paginationElementsAllowed = data.meta.total > dataMetaPerPage; // show pagination-related elements
        }, 2100);
      },
    });
  }

  public updateMasonry(): void {
    this.masonry?.layout();
  }

  public pageChanged(page: any): void {
    this.pagination.page = page;
    this.params.page = page;
    this.getPostsSubject.next({ params: this.params });
  }

  public setIsLoadingOnCardClick() {
    // With this skeleton loader's css is properly displayed (when navigating to POST mode) through post card click,
    // and the post card is able to detect to not load the skeleton UI loader after posts have successfully shown up
    this.posts.length && this.mode === FeedMode.Tiles
      ? (this.isLoading = true)
      : this.isLoading === !this.posts.length;
  }

  public showPostDetails(post: PostResult): void {
    this.updateMasonry(); // never forget this guy when you need styles to adjust for masonry library

    /* Remainder comment: 
       Naturally, the "navigateTo" function should have been directly placed here
       This is because routing is triggered by it regardless of the size of the 
       screen.
       -------------------------------
       But, we don't want to allow routing yet, if the event supplied to 
       this.modal does not match the method (see modal code and comments to 
       understand better). Therefore, the "navigateTo" function is called 
       in the modal code after the check.
       -------------------------------
       That said, If we ever decide to remove the modal totally, we can then call
       "navigateTo" directly here if we still need to route to any of the "ID Modes" 
       on card click - as shown in the comment below.
    */
    // this.navigateTo().idMode.view({ post });

    this.eventToTriggerModal = 'click';
    const value = this.eventToTriggerModal as 'click';
    this.modal({ event: value }).popup.onClick({ post });
  }

  public modal({ event }: { event: 'none' | 'click' | 'load' | 'resize' }) {
    const openModal = (post: PostResult) => {
      // Smaller devices only [NOTE: see CSS inside the PostDetailsModalComponent for CSS reize related fix]
      if (!this.isDesktop) {
        if (!this.dialog.openDialogs.length) {
          // !this.dialog.openDialogs.length check needed to prevent more than one modals from showing up RESIZE
          this.postDetailsModal = this.dialog.open(PostDetailsModalComponent, {
            width: '100%',
            maxWidth: 576,
            data: { post: post, color: post.color, twitterId: post.data_source_message_id },
            height: 'auto',
            maxHeight: '90vh',
            panelClass: ['modal', 'post-modal', 'resize-css-handler'],
          });
        }
      }

      // Regardless of device size, save post result from/on card click
      // Saving it will be useful for when we need to be able to trigger modal open/close on resize
      localStorage.setItem('feedview_postObj', JSON.stringify(post));

      // Smaller devices only - what happens after modal is closed
      // Note: [mat-dialog-close]="false" in the html of the modal takes care of closing the modal
      this.postDetailsModal?.afterClosed().subscribe((data) => {
        if (!data && !this.isDesktop) {
          // adding !isDesktop to the check prevents misbehaving and makes sure routing only takes place if current modal is closed when on smaller devices
          if (!this.dialog.openDialogs.length) {
            // !this.dialog.openDialogs.length check needed to allow routing to TILES MODE on RESIZE
            this.router.navigate(['/feed'], {
              queryParams: {
                mode: FeedMode.Tiles,
              },
              queryParamsHandling: 'merge',
            });
          }
        }
      });
    };

    //----------------------------------------------
    // We always want event used by engineer to match the method to use, otherwise throw error in console
    const error = (usedEvent: string, allowedEvent: string) => {
      return `Contradiction Error: Cannot use '${usedEvent}' event with .on${capitalize(
        allowedEvent,
      )}({}) method. 
      
      The correct usage in this case is: 
      this.modal({ event: ${allowedEvent} }).on${capitalize(allowedEvent)}({});

      If you intend to use the '${usedEvent}', ensure to use the matching this.modal method for the '${usedEvent}' event which is the .on${capitalize(
        usedEvent,
      )}({}) method
      `;
    };

    // Code abstraction to hide similar but not so relevant details, prevent repetition and code looking bulky in the methods returned
    const runCode = (allowedEvent: string, performAction: () => void) => {
      if (event !== allowedEvent) {
        throw new Error(error(event, allowedEvent));
      } else {
        performAction();
      }
    };
    //----------------------------------------------

    return {
      popup: {
        onClick: ({ post }: { post: PostResult }) => {
          const allowedEvent = 'click';
          runCode(allowedEvent, () => {
            this.navigateTo().idMode.view({ id: post.id });
            openModal(post as PostResult);
          });
        },
        onLoad: ({ id }: { id: number }) => {
          const allowedEvent = 'load';
          runCode(allowedEvent, () => {
            this.navigateTo().idMode.view({ id: id as number });
            this.postsService.getById(id as number).subscribe({
              next: (fetchedPost: PostResult) => {
                openModal(fetchedPost);
              },
              // error: (err) => {
              //   // console.log(err.status);
              //   if (err.status === 404) {
              //     this.router.navigate(['/not-found']);
              //   }
              // },
            });
          });
        },
        // To be used inside of a window resize event listener
        // eslint-disable-next-line no-empty-pattern
        onResize: ({}) => {
          const allowedEvent = 'resize';
          runCode(allowedEvent, () => {
            // Simulate card click on RESIZE
            if (this.mode === FeedMode.Post) {
              if (window.innerWidth >= 1024) {
                this.postDetailsModal.close();
                // console.log(this.dialog.openDialogs);
              } else {
                if (this.dialog.openDialogs.length) {
                  for (let i = 0; i <= this.dialog.openDialogs.length; i += 1) {
                    if (i === 0 && this.dialog.openDialogs.length === 1) {
                      const firstPostFromOpenModalDialog =
                        this.dialog.openDialogs[0].componentInstance.data.post;
                      openModal(firstPostFromOpenModalDialog);
                      break;
                    }
                  }
                } else {
                  const postFromStorage = JSON.parse(
                    localStorage.getItem('feedview_postObj') as string,
                  );
                  openModal(postFromStorage);
                }
                // console.log(this.dialog.openDialogs);
              }
            }
          });
        },
      },
    };
  }

  public navigateTo = () => {
    return {
      // [Remove comment later] Note: PREVIEW mode is formally called TILES mode... Still refactoring
      // eslint-disable-next-line no-empty-pattern
      // previewMode: ({}) => {
      //   // router code for "TILES mode" (now preview mode) goes here
      // },
      // [Remove comment later] Note: ID mode is formally called POST mode... Still refactoring
      idMode: {
        view: ({ id }: { id: number }) => {
          this.router.navigate([id, 'view'], {
            relativeTo: this.route,
            queryParams: {
              mode: FeedMode.Post,
            },
            queryParamsHandling: 'merge',
          });
        },
        // TODO: add edit prop later, when refactoring gets there
        // edit: ({ post }: { post: PostResult }) => {
        //   // router code for edit-related pages go here
        // },
      },
    };
  };

  public toggleBulkOptions(state: boolean): void {
    this.isBulkOptionsVisible = state;
    if (!this.isBulkOptionsVisible) {
      this.deselectAllPosts();
    }
  }

  public changePostsStatus(status: string): void {
    if (status === PostStatus.Published) {
      const uncompletedPosts: PostResult[] = this.selectedPosts.filter(
        (post: PostResult) => !postHelpers.isAllRequiredCompleted(post),
      );

      if (uncompletedPosts.length > 0) {
        this.showMessage(
          this.translate.instant('notify.post.posts_can_t_be_published', {
            titles: uncompletedPosts.map((p) => p.title).join(', '),
          }),
          'error',
          5000,
        );
        this.statusControl.reset();
        return;
      }
    }

    forkJoin(
      this.selectedPosts.map((p: PostResult) => this.postsService.update(p.id, { status })),
    ).subscribe({
      complete: () => {
        this.getPostsSubject.next({ params: this.params, add: false });
        this.statusControl.reset();
        this.deselectAllPosts();
      },
    });
  }

  public selectAllPosts(): void {
    this.posts.map((post) => {
      if (this.selectedPosts.find((selectedPost: PostResult) => selectedPost.id === post.id))
        return;
      this.selectedPosts.push(post);
    });
  }

  public deselectAllPosts(): void {
    this.selectedPosts = [];
  }

  public async deleteSelectedPosts(): Promise<void> {
    const confirmed = await this.confirmModalService.open({
      title: `${this.translate.instant(
        'app.are_you_sure_you_want_to_delete',
      )} ${this.translate.instant('post.post_count', { count: this.selectedPosts.length })}?`,
      description: this.translate.instant('app.action_cannot_be_undone'),
    });
    if (!confirmed) return;

    const count = this.selectedPosts.length;
    forkJoin(this.selectedPosts.map((p: PostResult) => this.postsService.delete(p.id))).subscribe({
      complete: () => {
        this.postDeleted(this.selectedPosts, count);
      },
    });
  }

  public postDeleted(posts: PostResult[], count?: number): void {
    this.getPostsSubject.next({ params: this.params, add: false });
    if (this.activePostId && posts.some((p: PostResult) => p.id === this.activePostId)) {
      if (this.collectionId) {
        this.router.navigate(['feed', 'collection', this.collectionId]);
      } else {
        this.router.navigate(['feed']);
      }
    }
    this.selectedPosts = [];
    if (count) {
      const postWord = count === 1 ? 'post' : 'posts';
      this.confirmModalService.open({
        title: this.translate.instant('notify.confirm_modal.deleted.success'),
        description: `<p>${this.translate.instant(
          'notify.confirm_modal.deleted.success_description',
          { count: `${count} ${postWord}` },
        )}</p>`,
        buttonSuccess: this.translate.instant('notify.confirm_modal.deleted.success_button'),
      });
      this.eventBusService.next({
        type: EventType.RefreshSurveysCounters,
        payload: true,
      });
    }
  }

  public postStatusChanged(): void {
    this.getPostsSubject.next({ params: this.params, add: false });
    this.selectedPosts = [];
  }

  public isPostSelected(isChecked: boolean, post: PostResult): void {
    if (isChecked) {
      this.selectedPosts.push(post);
    } else {
      const index = this.selectedPosts.findIndex((p: PostResult) => p.id === post.id);
      if (index > -1) {
        this.selectedPosts.splice(index, 1);
      }
    }
  }

  public isPostChecked(post: PostResult): boolean {
    return !!this.selectedPosts.find((p: PostResult) => p.id === post.id);
  }

  public sortPosts(value: any): void {
    this.activeSorting = value;
    this.postsService.setSorting(this.activeSorting);
    this.getPostsSubject.next({ params: this.params, add: false });
  }

  public refreshMasonry(): void {
    this.isLoading = true;
    this.updateMasonryLayout = !this.updateMasonryLayout;
  }

  public loadMore(): void {
    if (this.params.limit !== undefined && this.params.limit * this.params.page! < this.total) {
      this.loadingMorePosts = true;
      this.params.page! += 1;
      this.getPostsSubject.next({ params: this.params });
    }
  }

  public toggleFilters(value: boolean): void {
    if (value === this.isFiltersVisible) return;
    this.isFiltersVisible = value;
    this.sessionService.toggleFiltersVisibility(value);
  }

  // public currentFeedViewMode() {
  //   return {
  //     get: localStorage.getItem('ui_feed_mode'),
  //     set: localStorage.setItem('ui_feed_mode', this.mode),
  //   };
  // }

  public switchMode(mode: FeedMode): void {
    console.log(mode);
    // 1. If there are no posts "The switch buttons shouldn't 'try to work'"
    // Reason is because the switch buttons alongside all other elements disabled when the page is still loading, shouldn't even show up in the first place) [when there are no posts].
    // So the check is a defense for or "validation" against errors that may occur from clicking it - if the button shows up by mistake when it's not supposed to [when there are no posts].

    // 2. The switch mode button of the mode you are on should also not work if you click on it while in that mode
    // const localStorageFeedMode = this.currentFeedViewMode().get;
    // const sameSwitchButtonClicked = localStorageFeedMode === mode;
    // if (this.atLeastOnePostExists && !sameSwitchButtonClicked) {
    //   //-------------------------------------
    //   // Show loader & prevent pagination elements flicker on use of switch mode buttons
    //   this.isLoading = true;
    //   this.paginationElementsAllowed = false;
    //   //-------------------------------------
    //   this.mode = mode;
    //   if (this.collectionId) {
    //     this.switchCollectionMode();
    //     return;
    //   }
    //   if (this.mode === FeedMode.Post) {
    //     this.router.navigate(['/feed', this.posts[0].id, 'view'], {
    //       queryParams: {
    //         mode: this.mode,
    //       },
    //       queryParamsHandling: 'merge',
    //     });
    //   } else {
    //     this.router.navigate(['/feed'], {
    //       queryParams: {
    //         mode: this.mode,
    //       },
    //       queryParamsHandling: 'merge',
    //     });
    //   }
    // }
  }

  switchCollectionMode() {
    if (this.mode === FeedMode.Post) {
      this.router.navigate(['/feed', 'collection', this.collectionId, this.posts[0].id, 'view'], {
        queryParams: {
          mode: this.mode,
        },
        queryParamsHandling: 'merge',
      });
    } else {
      this.router.navigate(['/feed', 'collection', this.collectionId], {
        queryParams: {
          mode: this.mode,
        },
        queryParamsHandling: 'merge',
      });
    }
  }

  refreshPost({ id }: PostResult) {
    this.postsService.getById(id).subscribe((p) => {
      const updatedPost = _.cloneDeep(p);
      this.posts = this.posts.map((obj) => (obj.id === updatedPost.id ? updatedPost : obj));
    });
  }

  public changePage(page: number): void {
    // --------------------------------
    // Show loader & prevent pagination elements flicker on use of pagination element's buttons
    this.isLoading = true;
    this.paginationElementsAllowed = false;
    //------------------------------------
    this.toggleBulkOptions(false);
    this.currentPage = page;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        page: this.currentPage,
      },
      queryParamsHandling: 'merge',
    });
  }

  public editPost(post: any): void {
    if (this.isDesktop) {
      this.setIsLoadingOnCardClick();
      if (this.collectionId) {
        this.router.navigate(['/feed', 'collection', this.collectionId, post.id, 'edit'], {
          queryParams: {
            mode: FeedMode.Post,
          },
          queryParamsHandling: 'merge',
        });
      } else {
        this.router.navigate(['feed', post.id, 'edit'], {
          queryParams: {
            mode: FeedMode.Post,
          },
          queryParamsHandling: 'merge',
        });
      }
      return;
    }

    this.postDetailsModal = this.dialog.open(PostDetailsModalComponent, {
      width: '100%',
      maxWidth: 576,
      data: {
        editable: true,
        color: post.color,
        twitterId: post.data_source_message_id,
      },
      height: 'auto',
      maxHeight: '90vh',
      panelClass: ['modal', 'post-modal'],
    });

    this.postsService.getById(post.id).subscribe({
      next: (postV5: PostResult) => {
        this.postDetailsModal.componentInstance.post = postV5;
      },
    });

    this.postDetailsModal.afterClosed().subscribe((data) => {
      if (data?.update) {
        this.getPostsSubject.next({ params: this.params, add: false });
      }
    });
  }

  private showMessage(message: string, type: string, duration = 3000) {
    this.snackBar.open(message, 'Close', {
      panelClass: [type],
      duration,
    });
  }
}
